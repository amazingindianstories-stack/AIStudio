import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { importDrawio, labelText, parseXml } from "./import-drawio";

const model = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="Start&lt;br&gt;&lt;b&gt;here&lt;/b&gt; &amp;amp; go" style="ellipse;fillColor=#ff0000;" vertex="1" parent="1"><mxGeometry x="100" y="50" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="b" value="Decide" style="rhombus;rounded=0;dashed=1;fillColor=url(javascript:x)" vertex="1" parent="1"><mxGeometry x="300" y="50" width="80" height="80" as="geometry"/></mxCell>
<mxCell id="e" style="edgeStyle=orthogonalEdgeStyle;" edge="1" source="a" target="b" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="f" style="endArrow=none;" edge="1" source="a" parent="1"><mxGeometry as="geometry"><mxPoint x="500" y="150" as="targetPoint"/></mxGeometry></mxCell>
</root></mxGraphModel>`;

let n = 0;
const opts = { newId: () => `id${++n}` };

test("imports shapes, labels and connectors, anchored at the origin", async () => {
  const { nodes, connectors } = await importDrawio(`<mxfile><diagram id="d">${model}</diagram></mxfile>`, { ...opts, origin: { x: 10, y: 20 } });
  assert.equal(nodes.length, 2);
  assert.deepEqual([nodes[0].type, nodes[0].x, nodes[0].y, nodes[0].fill], ["ellipse", 10, 20, "#ff0000"]);
  assert.equal(nodes[0].text, "Start\nhere & go");
  assert.equal(nodes[1].type, "diamond");
  assert.ok(!JSON.stringify(nodes).includes("javascript"));
  assert.equal(nodes[1].strokeStyle, "dashed");
  assert.equal(connectors.length, 2);
  assert.equal(connectors[0].shape, "elbow");
  assert.equal(connectors[0].from.nodeId, nodes[0].id);
  assert.equal(connectors[1].kind, "line");
  assert.deepEqual(connectors[1].to, { x: 410, y: 120 });
});

test("compressed diagrams are inflated", async () => {
  const body = deflateRawSync(Buffer.from(encodeURIComponent(model))).toString("base64");
  const { nodes } = await importDrawio(`<mxfile><diagram>${body}</diagram></mxfile>`, opts);
  assert.equal(nodes.length, 2);
});

test("rejects DOCTYPE, entities, malformed and empty files", async () => {
  await assert.rejects(importDrawio('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><mxfile/>'));
  await assert.rejects(importDrawio("<mxfile><diagram></mxfile>"));
  await assert.rejects(importDrawio("<mxGraphModel><root/></mxGraphModel>"));
  assert.throws(() => parseXml(`<a>${"<b>".repeat(70)}`));
});

test("labels drop tags", () => {
  assert.equal(labelText("<script>x</script>hi"), "xhi");
});
