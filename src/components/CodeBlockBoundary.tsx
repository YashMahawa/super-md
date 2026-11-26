import { Component, type ReactNode } from "react";
import CopyCode from "./CopyCode";

/** A damaged diagram must not take the rest of a study note down with it. */
export default class CodeBlockBoundary extends Component<{ source: string; sourceStart?: number; sourceEnd?: number; children: ReactNode }, { failed: boolean; source: string }> {
  state = { failed: false, source: this.props.source };
  static getDerivedStateFromProps(props: { source: string }, state: { failed: boolean; source: string }) {
    return props.source === state.source ? null : { failed: false, source: props.source };
  }
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="code-container" role="alert" data-source-start={this.props.sourceStart} data-source-end={this.props.sourceEnd}>
      <p>This block could not be rendered. Its source is still available to edit or copy.</p>
      <CopyCode source={this.props.source} />
      <details><summary>Show source</summary><pre><code>{this.props.source}</code></pre></details>
    </section>;
  }
}
