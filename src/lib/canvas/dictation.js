// Speech to text for the AI prompt, through the browser's own SpeechRecognition (no audio leaves the page for any
// service of ours). Absent in some browsers; callers hide the control then.

export function dictationSupported() {
  return typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/**
 * Start listening. `onText(transcript)` gets the finished phrases so far; `onEnd(error)` runs once when listening
 * stops. Returns a function that stops it.
 */
export function startDictation({ onText, onEnd, lang }) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = false;
  if (lang) recognition.lang = lang;
  let failure = null;
  recognition.onresult = (event) => {
    let text = "";
    for (let i = 0; i < event.results.length; i += 1) text += event.results[i][0].transcript;
    onText(text.trim());
  };
  recognition.onerror = (event) => {
    failure = event.error || "error";
  };
  recognition.onend = () => onEnd(failure);
  recognition.start();
  return () => recognition.stop();
}
