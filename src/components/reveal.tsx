"use client";

import { useEffect, useRef, useState, type ElementType, type ReactNode } from "react";

type RevealProps = {
  children: ReactNode;
  as?: ElementType;
  className?: string;
  id?: string;
  /** delay in ms before the element animates in once it enters view */
  delay?: number;
  /** re-run every time it enters the viewport instead of once */
  repeat?: boolean;
};

/**
 * Lightweight scroll-reveal wrapper. No animation library — just an
 * IntersectionObserver toggling the `.is-visible` class defined in globals.css.
 * Honours prefers-reduced-motion (the CSS forces the visible state).
 */
export function Reveal({
  children,
  as,
  className = "",
  id,
  delay = 0,
  repeat = false,
}: RevealProps) {
  const Tag = as ?? "div";
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }

    // Anything already on screen at mount is shown without waiting for the
    // observer. Cheap insurance: if IO never fires (throttled tab, odd
    // embedding), a section stays blank forever, which is worse than an
    // un-animated entrance.
    const box = node.getBoundingClientRect();
    if (box.top < window.innerHeight && box.bottom > 0) {
      setVisible(true);
      if (!repeat) return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            if (!repeat) observer.unobserve(entry.target);
          } else if (repeat) {
            setVisible(false);
          }
        }
      },
      { threshold: 0.16, rootMargin: "0px 0px -8% 0px" }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [repeat]);

  return (
    <Tag
      ref={ref}
      id={id}
      className={`reveal ${visible ? "is-visible" : ""} ${className}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}
