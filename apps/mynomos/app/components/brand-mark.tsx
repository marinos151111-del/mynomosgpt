type BrandMarkProps = {
  size?: "small" | "large";
};

export function BrandMark({ size = "small" }: BrandMarkProps) {
  return (
    <span className={`brand-mark brand-mark-${size}`} aria-hidden="true">
      <span className="brand-pillar" />
      <span className="brand-pillar brand-pillar-center" />
      <span className="brand-pillar" />
    </span>
  );
}
