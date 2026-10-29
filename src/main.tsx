import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/newsreader/400.css";
import "@fontsource/newsreader/400-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "pdfjs-dist/web/pdf_viewer.css";
import "./styles.css";
import App from "./App";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <main className="fatal-error">
        <h1>Let’s get your workspace back.</h1>
        <p>
          localTEX encountered a problem. Your saved files are safe in their
          folder.
        </p>
        <pre>{this.state.error}</pre>
        <button
          className="button primary"
          onClick={() => window.location.reload()}
        >
          Reopen localTEX
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
