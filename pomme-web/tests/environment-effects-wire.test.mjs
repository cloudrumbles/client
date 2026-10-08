import { test } from 'node:test';
import assert from 'node:assert/strict';
import mc from 'minecraft-protocol';
import minecraftData from 'minecraft-data';
import { MinecraftSession, simplifyNbt } from '../src/minecraft.js';
import { installNativeCodecs } from '../scripts/native-codec.mjs';
installNativeCodecs('26.1');
test('actual legacy effect wire retains typed FactorData and absence through session updates', () => {
  const version = '1.20.4', serializer = mc.createSerializer({ version, state: 'play', isServer: true }), decoder = mc.createDeserializer({ version, state: 'play', isServer: false });
  const client = new MinecraftSession({ registry: { version: { minecraftVersion: version }, effects: [{ id: 32, name: 'darkness' }] }, transport: { packet() {}, close() {} } }); client.state.entityId = 42;
  const fields = { padding_duration: { type: 'int', value: 22 }, factor_current: { type: 'float', value: .375 }, factor_previous_frame: { type: 'float', value: .25 }, ticks_active: { type: 'int', value: 9 } };
  const factor = { type: 'compound', value: fields };
  function send(factorCodec) { const raw = serializer.createPacketBuffer({ name: 'entity_effect', params: { entityId: 42, effectId: 32, amplifier: 0, duration: 100, hideParticles: 0, factorCodec } }); const packet = decoder.parsePacketBuffer(raw).data; client.receive({ type: 'packet', name: packet.name, data: packet.params, state: 'play' }); }
  send(factor); assert.deepEqual(client.state.effects[0].factorData.value, fields); assert.equal(simplifyNbt(client.state.effects[0].factorData).factor_current, .375);
  send(null); assert.equal(client.state.effects[0].factorData, null);
});
test('actual source-version world clocks retain full signed longs and dimension flat/debug flags', () => {
  for (const version of ['1.20.4', '1.21.11']) {
    const writer = mc.createSerializer({ version, state: 'play', isServer: true }), reader = mc.createDeserializer({ version, state: 'play', isServer: false }), clocks = [];
    const client = new MinecraftSession({ registry: { version: { minecraftVersion: version } }, transport: { packet() {}, close() {} }, onTime: value => clocks.push(value) });
    const send = (name, params) => { const packet = reader.parsePacketBuffer(writer.createPacketBuffer({ name, params })).data; client.receive({ type: 'packet', name: packet.name, data: packet.params, state: 'play' }); };
    const login = minecraftData(version).loginPacket;
    send('login', { ...login, isFlat: true, isDebug: true, ...(version === '1.20.4' ? { worldType: 'minecraft:overworld', worldName: 'minecraft:overworld', entityId: 42 } : { worldState: { ...login.worldState, isFlat: true, isDebug: true } }) });
    assert.equal(client.state.isFlat, true); assert.equal(client.state.isDebug, true);
    if (version === '1.20.4') {
      send('update_time', { age: 7000000000000000000n, time: -7000000000000000001n });
      assert.equal(clocks.at(-1).dayTime, 7000000000000000001n); assert.equal(clocks.at(-1).daylightCycle, false);
      send('update_time', { age: 1n, time: -9223372036854775808n }); assert.equal(clocks.at(-1).dayTime, -9223372036854775808n);
    } else {
      send('update_time', { age: 7000000000000000000n, time: 7000000000000000001n, tickDayTime: false });
      assert.equal(clocks.at(-1).dayTime, 7000000000000000001n); assert.equal(clocks.at(-1).daylightCycle, false);
      send('update_time', { age: 1n, time: -9223372036854775808n, tickDayTime: true }); assert.equal(clocks.at(-1).dayTime, -9223372036854775808n); assert.equal(clocks.at(-1).daylightCycle, true);
    }
    assert.equal(clocks[0].worldAge, 7000000000000000000n);
  }
});
test('actual modern effect wire retains native bit8 shouldBlend and omits legacy FactorData', () => {
  const version = '1.21.11', serializer = mc.createSerializer({ version, state: 'play', isServer: true }), decoder = mc.createDeserializer({ version, state: 'play', isServer: false });
  const client = new MinecraftSession({ registry: { version: { minecraftVersion: version }, effects: [{ id: 32, name: 'darkness' }] }, transport: { packet() {}, close() {} } }); client.state.entityId = 42;
  function send(flags) { const raw = serializer.createPacketBuffer({ name: 'entity_effect', params: { entityId: 42, effectId: 32, amplifier: 0, duration: 100, flags } }); const packet = decoder.parsePacketBuffer(raw).data; client.receive({ type: 'packet', name: packet.name, data: packet.params, state: 'play' }); }
  send(8); assert.equal(client.state.effects[0].shouldBlend, true); assert.equal(Object.hasOwn(client.state.effects[0], 'factorData'), false);
  send(7); assert.equal(client.state.effects[0].shouldBlend, false); send(15); assert.equal(client.state.effects[0].shouldBlend, true);
});
test('26.1 actual clock wire retains registry names, independent rates and signed long timeline times', () => {
  const version = '26.1', clocks = [], errors = [];
  const client = new MinecraftSession({ registry: { version: { minecraftVersion: version } }, transport: { packet() {}, close() {} }, onTime: value => clocks.push(value), onEvent: event => { if (event.type === 'error') errors.push(event.message); } });
  const wire = (state, name, params) => {
    const writer = mc.createSerializer({ version, state, isServer: true }), reader = mc.createDeserializer({ version, state, isServer: false });
    const packet = reader.parsePacketBuffer(writer.createPacketBuffer({ name, params })).data;
    client.receive({ type: 'packet', name: packet.name, data: packet.params, state });
  };
  wire('configuration', 'registry_data', { id: 'minecraft:world_clock', entries: ['example:moon', 'minecraft:overworld'].map(key => ({ key, value: { type: 'compound', value: {} } })) });
  wire('configuration', 'registry_data', { id: 'minecraft:dimension_type', entries: [{ key: 'example:world', value: { type: 'compound', value: { min_y: { type: 'int', value: -64 }, height: { type: 'int', value: 384 }, has_skylight: { type: 'byte', value: 1 }, default_clock: { type: 'string', value: 'example:moon' } } } }] });
  const login = minecraftData(version).loginPacket;
  wire('play', 'login', { ...login, worldState: { ...login.worldState, dimension: 0, name: 'example:world' } });
  wire('play', 'update_time', { age: 7000000000000000000n, clockUpdates: [{ id: 0, totalTicks: 7000000000000000004n, partialTick: .5, rate: 0 }, { id: 1, totalTicks: 1234n, partialTick: .25, rate: 2 }] });
  assert.deepEqual(errors, []); assert.equal(clocks[0].dayTime, 7000000000000000004n); assert.equal(clocks[0].defaultClock, 'example:moon'); assert.equal(clocks[0].daylightCycle, false);
  assert.equal(client.clockStates.get('minecraft:overworld').totalTicks, 1234n); assert.equal(client.clockStates.get('minecraft:overworld').rate, 2); assert.equal(client.clockStates.get('example:moon').partialTick, .5);
  wire('play', 'update_time', { age: 1n, clockUpdates: [{ id: 1, totalTicks: 4321n, partialTick: 0, rate: 1 }] });
  assert.equal(clocks[1].dayTime, 7000000000000000004n, 'An unrelated sparse clock update must preserve the dimension clock.');
  wire('play', 'update_time', { age: 1n, clockUpdates: [{ id: 0, totalTicks: BigInt.asUintN(64, -9223372036854775808n), partialTick: 0, rate: 0 }] });
  assert.equal(clocks[2].dayTime, -9223372036854775808n);
  wire('configuration', 'registry_data', { id: 'minecraft:world_clock', entries: [{ key: 'example:replacement', value: { type: 'compound', value: {} } }] });
  assert.equal(client.clockStates.size, 0, 'Registry replacement retires old named clock state.');
});
