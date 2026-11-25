import type { DocumentMetadata, YamlValue } from "../frontmatter";

interface DocumentPropertiesProps {
  properties: DocumentMetadata | null;
  entries?: Record<string, YamlValue>;
  showFallback?: boolean;
}

function isRenderedStandardKey(lowerKey: string, properties: DocumentMetadata | null): boolean {
  if (!properties) return false;
  switch (lowerKey) {
    case "title": return Boolean(properties.title);
    case "subtitle": return Boolean(properties.subtitle);
    case "author":
    case "authors":
    case "creator": return properties.authors.length > 0;
    case "date": return Boolean(properties.date);
    case "description":
    case "subject":
    case "abstract": return Boolean(properties.description);
    case "tags":
    case "tag":
    case "keywords": return properties.tags.length > 0;
    case "aliases":
    case "alias": return properties.aliases.length > 0;
    default: return false;
  }
}

function formatYamlInline(value: YamlValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length ? value.map(formatYamlInline).join(", ") : "[]";
  const pairs = Object.entries(value);
  return pairs.length ? pairs.map(([k, v]) => `${k}: ${formatYamlInline(v)}`).join(", ") : "{}";
}

export default function DocumentProperties({ properties, entries, showFallback = false }: DocumentPropertiesProps) {
  const title = properties?.title;
  const subtitle = properties?.subtitle;
  const authors = properties?.authors ?? [];
  const date = properties?.date;
  const description = properties?.description;
  const tags = properties?.tags ?? [];
  const aliases = properties?.aliases ?? [];
  const customEntries = showFallback && entries
    ? Object.entries(entries).filter(([key]) => !isRenderedStandardKey(key.toLowerCase(), properties))
    : [];
  const hasStandardRows = authors.length > 0 || Boolean(date) || Boolean(description) || tags.length > 0 || aliases.length > 0;
  const hasRows = hasStandardRows || customEntries.length > 0;
  const isEmpty = !title && !subtitle && !hasRows;
  if (isEmpty && !showFallback) return null;
  if (isEmpty) {
    return (
      <section className="document-properties document-properties--empty" data-frontmatter-properties="true" aria-label="Document properties">
        <div className="document-properties-empty">YAML frontmatter</div>
      </section>
    );
  }
  return (
    <section className="document-properties" data-frontmatter-properties="true" aria-label="Document properties">
      {(title || subtitle) && (
        <div className="document-properties-heading">
          {title && <div className="document-properties-title">{title}</div>}
          {subtitle && <div className="document-properties-subtitle">{subtitle}</div>}
        </div>
      )}
      {hasRows && (
        <dl className="document-properties-list">
          {authors.length > 0 && (
            <div className="document-property">
              <dt className="document-property-label">Author</dt>
              <dd className="document-property-value">{authors.join(", ")}</dd>
            </div>
          )}
          {date && (
            <div className="document-property">
              <dt className="document-property-label">Date</dt>
              <dd className="document-property-value">{date}</dd>
            </div>
          )}
          {description && (
            <div className="document-property document-property--wide">
              <dt className="document-property-label">Description</dt>
              <dd className="document-property-value">{description}</dd>
            </div>
          )}
          {tags.length > 0 && (
            <div className="document-property document-property--wide">
              <dt className="document-property-label">Tags</dt>
              <dd className="document-property-badges">
                {tags.map(tag => (
                  <span key={tag} className="document-property-badge">{tag}</span>
                ))}
              </dd>
            </div>
          )}
          {aliases.length > 0 && (
            <div className="document-property document-property--wide">
              <dt className="document-property-label">Aliases</dt>
              <dd className="document-property-badges">
                {aliases.map(alias => (
                  <span key={alias} className="document-property-badge document-property-badge--subtle">{alias}</span>
                ))}
              </dd>
            </div>
          )}
          {customEntries.map(([key, value]) => {
            const emptyScalar = value === null || value === "";
            const formatted = emptyScalar ? "" : formatYamlInline(value);
            const wide = formatted.includes("\n") || formatted.length > 48;
            return (
              <div key={`custom:${key}`} className={`document-property${wide ? " document-property--wide" : ""}`}>
                <dt className="document-property-label">{key}</dt>
                <dd className="document-property-value">
                  {emptyScalar ? <span className="document-property-empty">—</span> : formatted}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}
