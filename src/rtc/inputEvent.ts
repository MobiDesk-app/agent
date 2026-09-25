import { z } from "zod";

// Crosses a real trust boundary: this is parsed straight out of a WebRTC
// data channel message sent by whatever phone is currently connected, so it
// gets the same "validate at the boundary" treatment as every other message
// in this project, not just a TS cast.
const mouseButtonSchema = z.enum(["left", "right", "middle"]);

export const inputEventSchema = z.discriminatedUnion("type", [
  // xRatio/yRatio are 0..1 fractions of screen width/height, not pixels —
  // the phone's viewport resolution has nothing to do with the PC's.
  z.object({
    type: z.literal("mousemove"),
    xRatio: z.number().min(0).max(1),
    yRatio: z.number().min(0).max(1),
  }),
  z.object({ type: z.literal("mousedown"), button: mouseButtonSchema }),
  z.object({ type: z.literal("mouseup"), button: mouseButtonSchema }),
  z.object({ type: z.literal("wheel"), deltaX: z.number(), deltaY: z.number() }),
  // `key` must match a nut-js Key enum member name (e.g. "A", "Enter",
  // "Space"). Mapping from real keyboard/touch-keyboard key names is a
  // follow-up — see agent/README.md "Not done yet".
  z.object({ type: z.literal("keydown"), key: z.string().min(1) }),
  z.object({ type: z.literal("keyup"), key: z.string().min(1) }),
]);

export type InputEvent = z.infer<typeof inputEventSchema>;
export type MouseButton = z.infer<typeof mouseButtonSchema>;
