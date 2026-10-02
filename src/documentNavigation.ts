import { visit } from "unist-util-visit";

export function headingSlug(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-") || "section";
}
export function headingText(node: any): string {
  return typeof node.value === "string" ? node.value : (node.children || []).map(headingText).join("");
}
export function remarkHeadingIds() {
  return (tree: unknown) => {
    const counts = new Map<string, number>();
    visit(tree as never, "heading", (node: any) => {
      const slug = headingSlug(headingText(node)), count = counts.get(slug) || 0;
      counts.set(slug, count + 1);
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: slug + (count ? `-${count}` : ""), "data-heading-key": slug } };
    });
  };
}
export function navigateHeading(link: HTMLAnchorElement): boolean {
  const href = link.getAttribute("href"); if (!href?.startsWith("#")) return false;
  let target = href.slice(1); try { target = decodeURIComponent(target); } catch { /* literal fragment */ }
  const root = link.closest(".reading-scroll,.live-pane,.android-reading") || link.closest(".markdown-body")?.parentElement;
  if (!root) return false;
  const headings = Array.from(root.querySelectorAll<HTMLElement>("[data-heading-key]"));
  const counts = new Map<string, number>();
  for (const heading of headings) { const key = heading.dataset.headingKey!, count = counts.get(key) || 0; counts.set(key, count + 1); heading.id = key + (count ? `-${count}` : ""); }
  const heading = headings.find(node => node.id === target) || headings.find(node => node.id === headingSlug(target));
  if (!heading) return true; // Broken local links must not escape into a browser.
  heading.scrollIntoView({ block: "start", behavior: document.documentElement.dataset.motion === "off" ? "instant" : "smooth" });
  heading.tabIndex = -1; heading.focus({ preventScroll: true });
  return true;
}
