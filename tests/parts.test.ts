import assert from 'node:assert/strict';
import test from 'node:test';
import { PARTS, PART_TYPES, partBody, partPads, partPins } from '../src/project/parts.ts';
import { parseProject, serializeProject } from '../src/project/projectFile.ts';
import { runSpiceSimulation } from '../src/simulation/spiceSolver.ts';
import type { ComponentType, SchematicComponent, PCBFootprint } from '../src/types/pcb.ts';

/** Everything the project validator and the solver both need to agree on for one part. */
const place = (type: ComponentType, id: string, x = 200, y = 200): SchematicComponent => ({
  id, type, name: id, value: PARTS[type].value, x, y, rotation: 0,
  pins: partPins(type), params: { ...PARTS[type].params },
});
const footprint = (type: ComponentType, id: string, x = 20, y = 20): PCBFootprint => ({
  id, componentId: id, type, x, y, rotation: 0, ...partBody(type), pads: partPads(type), isPlaced: true,
});

test('the library covers every component type the application declares', () => {
  const declared = Object.keys(PARTS) as ComponentType[];
  assert.deepEqual(PART_TYPES, declared);
  assert.ok(PART_TYPES.length >= 13, `expected the full library, found ${PART_TYPES.length}`);
  // Three types once existed in the solver and the type union but in no library or factory.
  for (const type of ['mosfet_n', 'zener', 'potentiometer'] as ComponentType[]) {
    assert.ok(PART_TYPES.includes(type), `${type} is missing from the library`);
  }
});

test('every part has one pad per pin, sharing ids', () => {
  for (const type of PART_TYPES) {
    const pins = partPins(type).map(pin => pin.id).sort();
    const pads = partPads(type).map(pad => pad.id).sort();
    assert.equal(new Set(pins).size, pins.length, `${type} has duplicate pin ids`);
    assert.equal(new Set(pads).size, pads.length, `${type} has duplicate pad ids`);
    // The project validator rejects a footprint that does not represent every pin.
    assert.deepEqual(pads, pins, `${type} pads and pins disagree`);
  }
});

test('every part carries usable geometry', () => {
  for (const type of PART_TYPES) {
    const body = partBody(type);
    assert.ok(body.width > 0 && body.height > 0, `${type} has no body`);
    for (const pad of partPads(type)) {
      assert.ok(pad.diameter > 0, `${type}:${pad.id} has no copper`);
      // A drill at or beyond the pad diameter leaves no annular ring to solder to.
      assert.ok(pad.holeDiameter >= 0 && pad.holeDiameter < pad.diameter, `${type}:${pad.id} drill swallows the pad`);
    }
    assert.ok(partPins(type).every(pin => Number.isFinite(pin.relX) && Number.isFinite(pin.relY)), `${type} has a pin nowhere`);
  }
});

test('the table hands out copies, never its own rows', () => {
  const first = partPins('resistor');
  first[0].relX = 999;
  assert.notEqual(partPins('resistor')[0].relX, 999, 'a placed component must not alias the library');

  const pads = partPads('resistor');
  pads[0].diameter = 999;
  assert.notEqual(partPads('resistor')[0].diameter, 999);

  const body = partBody('resistor');
  body.width = 999;
  assert.notEqual(partBody('resistor').width, 999);
});

test('a board holding one of every part survives a save and reload', () => {
  // This is the check that would have caught three types whose factories returned nothing:
  // a component with no pins, or a footprint with no pads, is refused by the validator.
  const placeable = PART_TYPES;
  const project = {
    name: 'every part',
    schematic: {
      components: placeable.map((type, index) => place(type, `P${index}`, 100 + index * 90, 200)),
      wires: [],
    },
    pcbLayout: {
      boardWidth: 200, boardHeight: 120,
      footprints: placeable.map((type, index) => footprint(type, `P${index}`, 15 + index * 14, 20)),
      traces: [], vias: [], pours: [],
    },
  };
  const reloaded = parseProject(serializeProject(project));
  assert.equal(reloaded.schematic.components.length, placeable.length);
  assert.equal(reloaded.pcbLayout.footprints.length, placeable.length);
});

test('the solver accepts the terminals the library gives every part', () => {
  // runSpiceSimulation rejects a component whose pins do not match what it models. Each part
  // is offered on its own with a ground so that the only thing under test is its pin set.
  for (const type of PART_TYPES) {
    if (type === 'gnd') continue;
    // An unwired part leaves the matrix singular, which is fine and expected: the only
    // question here is whether the solver recognised the terminals at all.
    let message: string;
    try {
      message = runSpiceSimulation(
        { components: [place(type, 'P1'), place('gnd', 'G1')], wires: [] },
        { type: 'transient', stopTime: 1e-3, stepTime: 1e-4 },
      ).errorMessage ?? '';
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.ok(!/unsupported or missing pins|duplicate pins/.test(message), `${type}: ${message}`);
  }
});

test('a potentiometer declares a wiper the solver can split its track at', () => {
  const pins = partPins('potentiometer').map(pin => pin.id);
  assert.deepEqual(pins, ['1', '2', '3']);
  assert.equal(PARTS.potentiometer.params.position, 50, 'a new pot starts centred');
  assert.ok(PARTS.potentiometer.params.resistance > 0);
});

test('a MOSFET declares the threshold and transconductance the solver reads', () => {
  assert.deepEqual(partPins('mosfet_n').map(pin => pin.id), ['g', 'd', 's']);
  assert.ok(PARTS.mosfet_n.params.vth > 0, 'a threshold of zero would conduct at rest');
  assert.ok(PARTS.mosfet_n.params.kn > 0);
});

test('a zener carries a breakdown voltage its value string actually parses to', () => {
  assert.deepEqual(partPins('zener').map(pin => pin.id), ['a', 'c']);
  // The solver falls back to 5.1V when the value does not parse, which would hide a typo here.
  const parsed = Number.parseFloat(PARTS.zener.value);
  assert.ok(Number.isFinite(parsed) && parsed > 0, `zener value ${PARTS.zener.value} does not read as a voltage`);
});
