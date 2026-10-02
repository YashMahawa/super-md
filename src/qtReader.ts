// Native Qt owns all chrome. Only the document/editor is shared with Android.
document.documentElement.dataset.host = "qt";
type QtStudio = { post: (id: string, command: string, args: string) => void; replied: { connect: (callback: (id: string, result: string, error: string) => void) => void } };
declare global {
  interface Window {
    QWebChannel: new (transport: unknown, ready: (channel: { objects: { studio: QtStudio } }) => void) => unknown;
    qt: { webChannelTransport: unknown };
  }
}
new window.QWebChannel(window.qt.webChannelTransport, async channel => {
  const studio = channel.objects.studio;
  window.SuperMD = { post: (id, command, args) => studio.post(id, command, args) };
  studio.replied.connect((id, result, error) => window.supermdReply?.(id, JSON.parse(result), error || null));
  await import("./androidReader");
});
export {};
