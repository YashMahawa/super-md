import type { DocumentMetadata } from "../frontmatter";

export default function DocumentProperties({ properties }: { properties: DocumentMetadata }) {
  const { title, subtitle, authors, date, description, tags, aliases } = properties;
  const hasRows = authors.length > 0 || Boolean(date) || Boolean(description) || tags.length > 0 || aliases.length > 0;
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
        </dl>
      )}
    </section>
  );
}
