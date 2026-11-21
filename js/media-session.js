import { clamp } from "./utils.js";

export function createMediaSession(navigator, Metadata, reportError) {
  let session;
  try { session = navigator.mediaSession; }
  catch (error) { reportError("Media Session access", error); }
  return {
    setMetadata({ title, chapter, artwork }) {
      if (!session || !Metadata) return;
      try {
        session.metadata = new Metadata({
          title: chapter || title, album: chapter ? title : "", artwork: artwork ? [{ src: artwork }] : [],
        });
      } catch (error) { reportError("Media Session metadata", error); }
    },

    setPosition(position, duration, playbackRate) {
      if (!duration) return;
      try { session?.setPositionState?.({ duration, position: clamp(position, 0, duration), playbackRate }); }
      catch (error) { reportError("Media Session position", error); }
    },

    setPlaybackState(state) {
      if (!session) return;
      try { session.playbackState = state; }
      catch (error) { reportError("Media Session playback state", error); }
    },

    bind(handlers) {
      if (!session) return;
      const bound = [];
      for (const [action, handler] of Object.entries(handlers)) {
        try {
          session.setActionHandler(action, handler);
          bound.push(action);
        }
        catch (error) { reportError(`Media Session ${action}`, error); }
      }
      return () => {
        for (const action of bound) {
          try { session.setActionHandler(action, null); }
          catch (error) { reportError(`Media Session ${action}`, error); }
        }
      };
    },
  };
}
