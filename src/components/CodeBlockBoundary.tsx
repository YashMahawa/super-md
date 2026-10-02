import { Component, type ReactNode } from "react";
import CopyCode from "./CopyCode";

/** A damaged diagram must not take the rest of a study note down with it. */
export default class CodeBlockBoundary extends Component<{ source: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="code-container" role="alert">
      <p>This block could not be rendered. Its source is still available to edit or copy.</p>
      <CopyCode source={this.props.source} />
      <details><summary>Show source</summary><pre><code>{this.props.source}</code></pre></details>
    </section>;
  }
}
