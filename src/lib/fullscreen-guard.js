function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
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
      await nextFrame();
      await nextFrame();
      if (doc.fullscreenElement) throw error;
      return true;
    }
    await nextFrame();
    await nextFrame();
    return true;
  }

  // Safari's native video fullscreen predates the standard document API.
  const video = doc.querySelector?.("[data-detail-video]");
  if (video?.webkitDisplayingFullscreen && typeof video.webkitExitFullscreen === "function") {
    video.webkitExitFullscreen();
    await nextFrame();
    await nextFrame();
    return true;
  }
  return false;
}
