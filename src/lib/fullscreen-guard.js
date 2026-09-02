const PAINT_SETTLE_TIMEOUT_MS = 250;

function waitForTwoFramesOrTimeout(doc) {
  const view = doc?.defaultView || globalThis;
  const requestFrame = view.requestAnimationFrame?.bind(view);
  const setTimer = view.setTimeout?.bind(view) || setTimeout;
  const clearTimer = view.clearTimeout?.bind(view) || clearTimeout;

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) clearTimer(timeoutId);
      resolve();
    };
    timeoutId = setTimer(finish, PAINT_SETTLE_TIMEOUT_MS);
    if (typeof requestFrame === "function") {
      requestFrame(() => requestFrame(finish));
    }
  });
}

export function hasFullscreenMedia(doc = document) {
  if (doc.fullscreenElement) return true;
  return Boolean(doc.querySelector?.("[data-detail-video]")?.webkitDisplayingFullscreen);
}

/**
 * Chrome can leave page hit-testing wedged when a fullscreen media element is
 * unmounted during its native exit transition. Always finish that transition
 * (plus two paint frames) before navigation or modal teardown mutates the DOM.
 */
export async function settleFullscreenBeforeMediaMutation(doc = document) {
  const fullscreenElement = doc.fullscreenElement;
  if (fullscreenElement && typeof doc.exitFullscreen === "function") {
    try {
      await doc.exitFullscreen();
    } catch (error) {
      // The browser may already be processing the same Escape key. Waiting for
      // paint is safe only if that competing exit actually removed fullscreen.
      await waitForTwoFramesOrTimeout(doc);
      if (doc.fullscreenElement) throw error;
      return true;
    }
    await waitForTwoFramesOrTimeout(doc);
    if (doc.fullscreenElement) {
      throw new Error("Fullscreen remained active after the browser exit request.");
    }
    return true;
  }

  // Safari's native video fullscreen predates the standard document API.
  const video = doc.querySelector?.("[data-detail-video]");
  if (video?.webkitDisplayingFullscreen && typeof video.webkitExitFullscreen === "function") {
    video.webkitExitFullscreen();
    await waitForTwoFramesOrTimeout(doc);
    if (video.webkitDisplayingFullscreen) {
      throw new Error("Native video fullscreen remained active after the browser exit request.");
    }
    return true;
  }
  return false;
}
