// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { BoardSwitcher } from "./canvas/BoardSwitcher";
import { ChatSidebar } from "./ChatSidebar";
const { fakeStore } = vi.hoisted(() => ({
  fakeStore: {
    activeProjectId: "project-a",
    projects: [{ id: "project-a", name: "Test project" }],
  },
}));
vi.mock("@/lib/store", () => ({ useStore: (selector) => selector(fakeStore) }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });
test("entering and leaving an empty board makes no create request", async () => {
  const fetch = vi.fn(async () => json({ boards: [] }));
  vi.stubGlobal("fetch", fetch);
  const { unmount } = render(
    <BoardSwitcher
      projectId="project-a"
      boardId={null}
      onBoardIdChange={vi.fn()}
    />,
  );
  await screen.findByRole("button", { name: "Create board" });
  unmount();
  expect(
    fetch.mock.calls.every(
      ([, options]) => !options.method || options.method === "GET",
    ),
  ).toBe(true);
});
test("explicit board creation sends exactly one POST in the shown project", async () => {
  const changed = vi.fn();
  const fetch = vi.fn(async (_, options) =>
    options.method === "POST"
      ? json({
          board: { id: "board-a", name: "Untitled board" },
          boards: [{ id: "board-a", name: "Untitled board" }],
        })
      : json({ boards: [] }),
  );
  vi.stubGlobal("fetch", fetch);
  render(
    <BoardSwitcher
      projectId="project-a"
      boardId={null}
      onBoardIdChange={changed}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Create board" }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith("board-a"));
  const writes = fetch.mock.calls.filter(
    ([, options]) => options.method === "POST",
  );
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0][1].body).projectId).toBe("project-a");
});
test("a failed board list is retryable and never treated as an empty board", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ error: "Unavailable" }, 500)),
  );
  render(
    <BoardSwitcher
      projectId="project-a"
      boardId={null}
      onBoardIdChange={vi.fn()}
    />,
  );
  await screen.findByRole("button", { name: "Could not load boards — Retry" });
  expect(screen.queryByRole("button", { name: "Create board" })).toBeNull();
});
test("empty Agents performs no write until Start conversation", async () => {
  const changed = vi.fn();
  const fetch = vi.fn(async (_, options) =>
    options.method === "POST"
      ? json({
          conversation: { id: "chat-a", name: "New chat" },
          conversations: [{ id: "chat-a", name: "New chat" }],
        })
      : json({ conversations: [] }),
  );
  vi.stubGlobal("fetch", fetch);
  render(
    <ChatSidebar
      agentKind="image"
      conversationId={null}
      onConversationIdChange={changed}
    />,
  );
  await screen.findByText("No chats yet.");
  expect(fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith("chat-a"));
  expect(
    fetch.mock.calls.filter(([, options]) => options.method === "POST"),
  ).toHaveLength(1);
});
