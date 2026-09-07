// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { EditableSetting } from "./EditableSetting";
afterEach(cleanup);
test("editing and tabbing never save; cancel restores baseline", () => {
  const save = vi.fn();
  render(
    <EditableSetting
      label="Model rate"
      value={12}
      unit="cents"
      onSave={save}
    />,
  );
  const input = screen.getByRole("spinbutton", { name: "Model rate (cents)" });
  fireEvent.focus(input);
  fireEvent.blur(input);
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "20" } });
  fireEvent.blur(input);
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toContain(
    "12 cents → 20 cents",
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(input.value).toBe("12");
});
test("rejected saves retain draft and retry only clears after success", async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("Forbidden"))
    .mockResolvedValueOnce({ ok: true });
  render(<EditableSetting label="Limit" value={3} onSave={save} />);
  const input = screen.getByRole("spinbutton");
  fireEvent.change(input, { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Forbidden"),
  );
  expect(input.value).toBe("5");
  expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Saved"),
  );
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  expect(input.value).toBe("5");
});
