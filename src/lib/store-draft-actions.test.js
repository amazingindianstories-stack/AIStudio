import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useStore } from "./store";
import { disposeStoreRuntime } from "./store-runtime";
const initial = useStore.getState();
const take = { id: "source", kind: "image", status: "succeeded", model: "Nano Banana Pro", prompt: "source prompt", aspectRatio: "1:1", referenceImages: ["/api/media/ref.png"] };
beforeEach(() => useStore.setState({ ...initial, items: [take], mode:"video", prompt:"Keep this draft", referenceImages:["old-ref"], referenceKinds:["image"], referenceLabels:["Costume"], modeDrafts:{} }));
afterEach(() => { disposeStoreRuntime(); useStore.setState(initial); vi.unstubAllGlobals(); });
test("failed reference download cannot clear the existing composer", async () => {
 vi.stubGlobal("fetch", vi.fn(async () => new Response("Unavailable", {status:500})));
 expect((await useStore.getState().cloneToComposer("source")).ok).toBe(false);
 expect(useStore.getState()).toMatchObject({mode:"video",prompt:"Keep this draft",referenceImages:["old-ref"]});
});
test("editing while clone references load wins over the delayed clone", async () => {
 let respond; vi.stubGlobal("fetch", vi.fn(() => new Promise(resolve => { respond=resolve; })));
 vi.stubGlobal("FileReader", class { readAsDataURL() { this.result="data:image/png;base64,test"; this.onload(); } });
 const pending=useStore.getState().cloneToComposer("source");
 useStore.getState().setPrompt("A newer draft"); respond(new Response("fake image"));
 expect((await pending).error).toContain("draft changed"); expect(useStore.getState().prompt).toBe("A newer draft");
});
test("clip deletion renumbers surviving tags and blocks silent retargeting", () => {
 useStore.setState({referenceVideos:["one","two"],prompt:"@vid1 beside @vid2"});
 useStore.getState().removeReferenceVideo(0);
 expect(useStore.getState().prompt).toBe("[removed reference] beside @vid1");
});
test("reference reorder preserves duplicate occurrences and role labels", () => {
 useStore.setState({referenceImages:["same","other","same"],referenceKinds:["image","video","image"],referenceLabels:["Identity","Motion","Costume"],prompt:"@img1 @img2 @img3"});
 useStore.getState().reorderReferences(["same","same","other"]);
 expect(useStore.getState().referenceLabels).toEqual(["Identity","Costume","Motion"]);
 expect(useStore.getState().prompt).toBe("@img1 @img3 @img2");
});
