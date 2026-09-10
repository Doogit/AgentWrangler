interface SectionHeaderProps {
  title: string;
  sub?: string;
}

/** A compact, consistent eyebrow heading for dashboard content sections. */
export default function SectionHeader({ title, sub }: SectionHeaderProps) {
  return (
    <div style={{ padding: "15px 16px 0" }}>
      <h2
        style={{
          margin: 0,
          color: "var(--soft)",
          fontSize: 15,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          fontVariant: "small-caps",
        }}
      >
        {title}
      </h2>
      {sub && (
        <p style={{ margin: "5px 0 0", color: "var(--muted)", fontSize: 12, lineHeight: 1.5 }}>
          {sub}
        </p>
      )}
    </div>
  );
}
