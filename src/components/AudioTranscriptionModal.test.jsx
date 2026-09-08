// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AudioTranscriptionModal } from "./AudioTranscriptionModal";
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(async () => ({ok:true,json:async()=>({items:[]})})) }));
afterEach(cleanup);
async function open() {
 render(<AudioTranscriptionModal open projectId="fixture" onClose={()=>{}} />);
 await waitFor(()=>expect(screen.getByRole("dialog")).toBeTruthy());
 return screen.getByRole("dialog");
}
test("drop selects audio, including extension fallback, without submitting", async () => {
 const dialog = await open();
 fireEvent.drop(dialog, {dataTransfer:{files:[new File(["audio"],"voice.mp3")],types:["Files"]}});
 expect(screen.getByRole("button",{name:"Choose or drop audio file"}).textContent).toContain("voice.mp3");
 expect(screen.getByRole("button",{name:"Transcribe audio"})).toBeTruthy();
});
test("invalid and multiple drops preserve the selected audio", async () => {
 const dialog = await open();
 const audio = new File(["audio"],"voice.wav",{type:"audio/wav"});
 fireEvent.drop(dialog,{dataTransfer:{files:[audio],types:["Files"]}});
 fireEvent.drop(dialog,{dataTransfer:{files:[new File(["image"],"image.png",{type:"image/png"})],types:["Files"]}});
 expect(screen.getByRole("alert").textContent).toContain("Choose MP3");
 fireEvent.drop(dialog,{dataTransfer:{files:[audio,audio],types:["Files"]}});
 expect(screen.getByRole("alert").textContent).toContain("one audio file");
 expect(screen.getByRole("button",{name:"Choose or drop audio file"}).textContent).toContain("voice.wav");
});
