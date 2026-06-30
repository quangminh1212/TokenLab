"use client";

import { useState } from "react";
import styled from "styled-components";

interface HeroSectionProps {
  stargazersCount: number;
}

export function HeroSection({ stargazersCount }: HeroSectionProps) {
  const [copied, setCopied] = useState(false);
  const starsText =
    stargazersCount > 0
      ? `${stargazersCount.toLocaleString()} stars`
      : "Star on GitHub";

  const handleCopy = () => {
    navigator.clipboard.writeText("bunx tokscale@latest");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <HeroWrapper>
      <HeroContent>
        <HeroTitle>
          The Kardashev
          <br />
          Scale for <HeroAccent>AI Devs</HeroAccent>
        </HeroTitle>

        <HeroSubtitle>
          Track, visualize, and compete on AI coding assistant token usage
          across Claude Code, Cursor, Windsurf, Codex, Gemini, and more.
        </HeroSubtitle>

        <HeroActions>
          <InstallBox>
            <InstallText>bunx tokscale@latest</InstallText>
            <CopyButton onClick={handleCopy}>
              {copied ? "Copied!" : "Copy"}
            </CopyButton>
          </InstallBox>

          <StarButton
            href="https://github.com/junhoyeo/tokscale"
            target="_blank"
            rel="noopener noreferrer"
          >
            <StarIcon />
            <StarButtonText>Star on GitHub</StarButtonText>
            <StarBadge>{starsText}</StarBadge>
          </StarButton>
        </HeroActions>
      </HeroContent>
    </HeroWrapper>
  );
}

const HeroWrapper = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 80px 24px 60px;
  background: var(--color-canvas-subtle);

  @media (max-width: 768px) {
    padding: 48px 16px 40px;
  }
`;

const HeroContent = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  max-width: 720px;
  text-align: center;
`;

const HeroTitle = styled.h1`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 700;
  font-size: 48px;
  line-height: 1.1em;
  letter-spacing: -0.03em;
  color: var(--color-fg-default);

  @media (max-width: 768px) {
    font-size: 36px;
  }

  @media (max-width: 480px) {
    font-size: 28px;
  }
`;

const HeroAccent = styled.span`
  color: var(--color-primary);
`;

const HeroSubtitle = styled.p`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 400;
  font-size: 18px;
  line-height: 1.5em;
  color: var(--color-fg-muted);
  max-width: 560px;

  @media (max-width: 480px) {
    font-size: 15px;
  }
`;

const HeroActions = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  width: 100%;
  max-width: 480px;

  @media (max-width: 480px) {
    gap: 12px;
  }
`;

const InstallBox = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  padding: 8px;
  background: var(--color-canvas-default);
  border: 1px solid var(--color-border-default);
  border-radius: 12px;
  width: 100%;
`;

const InstallText = styled.code`
  flex: 1;
  font-family: var(--font-mono), ui-monospace, monospace;
  font-weight: 600;
  font-size: 15px;
  color: var(--color-primary);
  padding: 0 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
`;

const CopyButton = styled.button`
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 8px 20px;
  background: var(--color-primary);
  border: none;
  border-radius: 8px;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity 0.15s;

  &:hover {
    opacity: 0.9;
  }

  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 700;
  font-size: 14px;
  color: #ffffff;
`;

const StarButton = styled.a`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  padding: 10px 24px;
  background: var(--color-canvas-default);
  border: 1px solid var(--color-border-default);
  border-radius: 12px;
  text-decoration: none;
  transition: all 0.15s;

  &:hover {
    border-color: var(--color-primary);
  }
`;

const StarIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M12 2L14.39 8.26L21 9.27L16.5 13.97L17.77 20.5L12 17.27L6.23 20.5L7.5 13.97L3 9.27L9.61 8.26L12 2Z"
      fill="var(--color-primary)"
    />
  </svg>
);

const StarButtonText = styled.span`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 700;
  font-size: 15px;
  color: var(--color-fg-default);
`;

const StarBadge = styled.span`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 600;
  font-size: 13px;
  color: var(--color-primary);
  background: var(--color-badge-bg);
  padding: 4px 10px;
  border-radius: 8px;
`;
