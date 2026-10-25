// When it is safe to reload onto a waiting service-worker version.
/**
 * A reload drops open dialogs, the viewer (with a pending rotation) and anything in flight,
 * so the update waits until none of them is active.
 * @param {{ modalOpen: boolean, viewerOpen: boolean, busy: boolean }} state
 */
export const canApplyUpdate = ({ modalOpen, viewerOpen, busy }) => !modalOpen && !viewerOpen && !busy
