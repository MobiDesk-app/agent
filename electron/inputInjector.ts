import { screen as electronScreen } from "electron";
import { mouse, keyboard, Button, Key, Point } from "@nut-tree-fork/nut-js";
import type { InputEvent, MouseButton } from "../src/rtc/inputEvent";

const NUT_JS_BUTTON: Record<MouseButton, Button> = {
  left: Button.LEFT,
  right: Button.RIGHT,
  middle: Button.MIDDLE,
};

function resolveKey(name: string): Key | undefined {
  // nut-js's Key is a plain enum; matching by member name keeps this
  // agnostic to whatever client sends events (see inputEvent.ts's note on
  // key-name mapping being a follow-up).
  return (Key as unknown as Record<string, Key | undefined>)[name];
}

/**
 * Applies one already-validated InputEvent to the real OS. Only main-process
 * code should call this — nut-js's native bindings aren't available in a
 * renderer, which is also why this lives in electron/, not src/.
 */
export async function applyInputEvent(event: InputEvent): Promise<void> {
  switch (event.type) {
    case "mousemove": {
      const { width, height } = electronScreen.getPrimaryDisplay().size;
      await mouse.setPosition(new Point(Math.round(event.xRatio * width), Math.round(event.yRatio * height)));
      return;
    }
    case "mousedown":
      await mouse.pressButton(NUT_JS_BUTTON[event.button]);
      return;
    case "mouseup":
      await mouse.releaseButton(NUT_JS_BUTTON[event.button]);
      return;
    case "wheel":
      if (event.deltaY) await (event.deltaY > 0 ? mouse.scrollDown : mouse.scrollUp)(Math.round(Math.abs(event.deltaY)));
      if (event.deltaX) await (event.deltaX > 0 ? mouse.scrollRight : mouse.scrollLeft)(Math.round(Math.abs(event.deltaX)));
      return;
    case "keydown": {
      const key = resolveKey(event.key);
      if (key === undefined) return void console.warn(`[input] unknown key "${event.key}", ignoring`);
      await keyboard.pressKey(key);
      return;
    }
    case "keyup": {
      const key = resolveKey(event.key);
      if (key === undefined) return;
      await keyboard.releaseKey(key);
      return;
    }
  }
}
