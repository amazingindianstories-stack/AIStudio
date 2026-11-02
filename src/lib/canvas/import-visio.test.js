import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { importVisio } from "./import-visio";

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = deflateRawSync(Buffer.from(content));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(8, 10);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(content.length, 24);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(head, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

const page = `<PageContents xmlns="http://schemas.microsoft.com/office/visio/2012/main"><Shapes>
<Shape ID="1"><Cell N="PinX" V="2"/><Cell N="PinY" V="4"/><Cell N="Width" V="2"/><Cell N="Height" V="1"/><Cell N="LocPinX" V="1"/><Cell N="LocPinY" V="0.5"/><Text>Start &amp; go</Text></Shape>
<Shape ID="2"><Cell N="PinX" V="6"/><Cell N="PinY" V="2"/><Cell N="Width" V="2"/><Cell N="Height" V="1"/><Cell N="LocPinX" V="1"/><Cell N="LocPinY" V="0.5"/><Cell N="FillForegnd" V="#ff0000"/><Text>End</Text></Shape>
<Shape ID="3"><Cell N="BeginX" V="3"/><Cell N="BeginY" V="4"/><Cell N="EndX" V="5"/><Cell N="EndY" V="2"/></Shape>
</Shapes><Connects><Connect FromSheet="3" FromCell="BeginX" ToSheet="1"/><Connect FromSheet="3" FromCell="EndX" ToSheet="2"/></Connects></PageContents>`;

let n = 0;
const opts = { newId: () => `id${++n}` };

test("imports shapes, text and connected connectors with the y axis flipped", async () => {
  const { nodes, connectors } = await importVisio(zip({ "visio/pages/page1.xml": page }), { ...opts, origin: { x: 10, y: 20 } });
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].text, "Start & go");
  assert.deepEqual([nodes[0].x, nodes[0].y, nodes[0].w], [10, 20, 192]);
  assert.equal(nodes[1].fill, "#ff0000");
  assert.ok(nodes[1].y > nodes[0].y);
  assert.deepEqual([connectors[0].from.nodeId, connectors[0].to.nodeId], [nodes[0].id, nodes[1].id]);
});

test("rejects non zip, non Visio, DOCTYPE and bomb input", async () => {
  await assert.rejects(importVisio(new Uint8Array(100)));
  await assert.rejects(importVisio(zip({ "other.xml": "<a/>" })));
  await assert.rejects(importVisio(zip({ "visio/pages/page1.xml": '<!DOCTYPE x [<!ENTITY e "x">]><PageContents/>' })));
  const big = zip({ "visio/pages/page1.xml": "a".repeat(6 * 1024 * 1024) });
  await assert.rejects(importVisio(big));
});
