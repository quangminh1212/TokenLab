"use client";

import { useState } from "react";
import styled, { keyframes } from "styled-components";

interface HeroSectionProps {
  stargazersCount: number;
}

const SUPPORTED_TOOLS = [
  "Claude Code", "Cursor", "Windsurf", "Codex", "Gemini", "Kimi", "Qwen", "OpenCode",
];

export function HeroSection({ stargazersCount }: HeroSectionProps) {
  const [copied, setCopied] = useState(false);
  const starsText =
    stargazersCount > 0
      ? `${stargazersCount.toLocaleString()}`
      : "Star";

  const handleCopy = () => {
    navigator.clipboard.writeText("bunx xlab-token@latest");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <HeroWrapper>
      <HeroGlow />
      <HeroContent>
        <HeroBadge>
          <BadgeDot />
          Open Source · Track AI Token Usage
        </HeroBadge>

        <HeroTitle>
          The Kardashev Scale
          <br />
          for <HeroAccent>AI Devs</HeroAccent>
        </HeroTitle>

        <HeroSubtitle>
          Track, visualize, and compete on AI coding assistant token usage
          across Claude Code, Cursor, Windsurf, Codex, Gemini, and more.
        </HeroSubtitle>

        <HeroActions>
          <InstallBox>
            <InstallPrompt>$</InstallPrompt>
            <InstallText>bunx xlab-token@latest</InstallText>
            <CopyButton onClick={handleCopy} $copied={copied}>
              {copied ? "✓ Copied!" : "Copy"}
            </CopyButton>
          </InstallBox>

          <StarButton
            href="https://github.com/quangminh1212/XLab_Token"
            target="_blank"
            rel="noopener noreferrer"
          >
            <StarIcon />
            <StarButtonText>Star on GitHub</StarButtonText>
            <StarBadge>{starsText}</StarBadge>
          </StarButton>
        </HeroActions>

        <ToolsRow>
          {SUPPORTED_TOOLS.map((tool) => (
            <ToolTag key={tool}>{tool}</ToolTag>
          ))}
        </ToolsRow>
      </HeroContent>
    </HeroWrapper>
  );
}

const fadeInUp = keyframes`
  from { opacity: 0; transform: translateY(24px); }
  to { opacity: 1; transform: translateY(0); }
`;

const HeroWrapper = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 100px 24px 80px;
  background: var(--color-canvas-subtle);
  position: relative;
  overflow: hidden;

  @media (max-width: 768px) {
    padding: 60px 16px 48px;
  }
`;

const HeroGlow = styled.div`
  position: absolute;
  top: -40%;
  left: 50%;
  transform: translateX(-50%);
  width: 600px;
  height: 600px;
  background: radial-gradient(circle, rgba(0, 161, 154, 0.08) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;

  @media (max-width: 768px) {
    width: 400px;
    height: 400px;
  }
`;

const HeroContent = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 28px;
  max-width: 760px;
  text-align: center;
  position: relative;
  z-index: 1;
  animation: ${fadeInUp} 0.6s ease-out forwards;

  @media (max-width: 480px) {
    gap: 20px;
  }
`;

const HeroBadge = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  background: var(--color-badge-bg);
  border: 1px solid color-mix(in srgb, var(--color-primary) 20%, transparent);
  border-radius: 100px;
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 600;
  font-size: 13px;
  color: var(--color-primary);
`;

const BadgeDot = styled.span`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-primary);
  animation: pulseGlow 2s ease-in-out infinite;
`;

const HeroTitle = styled.h1`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 800;
  font-size: 56px;
  line-height: 1.05em;
  letter-spacing: -0.035em;
  color: var(--color-fg-default);

  @media (max-width: 768px) {
    font-size: 40px;
  }

  @media (max-width: 480px) {
    font-size: 30px;
  }
`;

const HeroAccent = styled.span`
  background: linear-gradient(135deg, var(--color-primary) 0%, #00d4c8 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
`;

const HeroSubtitle = styled.p`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 400;
  font-size: 19px;
  line-height: 1.55em;
  color: var(--color-fg-muted);
  max-width: 580px;

  @media (max-width: 480px) {
    font-size: 15px;
  }
`;

const HeroActions = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  width: 100%;
  max-width: 500px;

  @media (max-width: 480px) {
    gap: 10px;
  }
`;

const InstallBox = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  padding: 6px 6px 6px 16px;
  background: var(--color-canvas-default);
  border: 1px solid var(--color-border-default);
  border-radius: 14px;
  width: 100%;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.04);
  transition: border-color 0.2s, box-shadow 0.2s;

  &:hover {
    border-color: color-mix(in srgb, var(--color-primary) 30%, var(--color-border-default));
    box-shadow: 0 4px 20px rgba(0, 161, 154, 0.08);
  }
`;

const InstallPrompt = styled.span`
  font-family: var(--font-mono), ui-monospace, monospace;
  font-weight: 600;
  font-size: 15px;
  color: var(--color-fg-subtle);
  flex-shrink: 0;
`;

const InstallText = styled.code`
  flex: 1;
  font-family: var(--font-mono), ui-monospace, monospace;
  font-weight: 600;
  font-size: 15px;
  color: var(--color-primary);
  padding: 0 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
`;

const CopyButton = styled.button<{ $copied: boolean }>`
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 10px 22px;
  background: ${(p) => (p.$copied ? "var(--color-primary-hover)" : "var(--color-primary)")};
  border: none;
  border-radius: 10px;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s;

  &:hover {
    opacity: 0.9;
    transform: translateY(-1px);
  }

  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 700;
  font-size: 14px;
  color: #ffffff;
  white-space: nowrap;
`;

const StarButton = styled.a`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  padding: 10px 22px;
  background: var(--color-canvas-default);
  border: 1px solid var(--color-border-default);
  border-radius: 14px;
  text-decoration: none;
  transition: all 0.2s;

  &:hover {
    border-color: var(--color-primary);
    transform: translateY(-1px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
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
  font-weight: 700;
  font-size: 13px;
  color: var(--color-primary);
  background: var(--color-badge-bg);
  padding: 4px 12px;
  border-radius: 8px;
`;

const ToolsRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  max-width: 620px;
  margin-top: 8px;
`;

const ToolTag = styled.span`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 500;
  font-size: 12px;
  color: var(--color-fg-muted);
  background: var(--color-canvas-default);
  border: 1px solid var(--color-border-subtle);
  padding: 4px 12px;
  border-radius: 100px;
  transition: all 0.15s;

  &:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
`;
