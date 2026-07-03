"use client";

import styled from "styled-components";

const FEATURES = [
  { title: "Multi-Tool Support", desc: "Tracks 30+ AI coding assistants including Claude Code, Cursor, Windsurf, Codex, Gemini, and more." },
  { title: "Cost Analytics", desc: "See exactly how much you're spending on AI APIs with per-model cost breakdowns." },
  { title: "Token Visualization", desc: "Interactive 2D and 3D graphs show your token usage patterns over time." },
  { title: "Global Leaderboard", desc: "Compete with developers worldwide. See where you rank on the Kardashev Scale." },
];

export function DescriptionSection() {
  return (
    <SectionWrapper>
      <DescriptionText>
        A high-performance CLI tool and visualization dashboard for tracking
        token usage and costs across <GradientText>multiple AI coding agents</GradientText>.
      </DescriptionText>
      <FeaturesGrid>
        {FEATURES.map((f) => (
          <FeatureCard key={f.title}>
            <FeatureTitle>{f.title}</FeatureTitle>
            <FeatureDesc>{f.desc}</FeatureDesc>
          </FeatureCard>
        ))}
      </FeaturesGrid>
      <GitHubBtn
        href="https://github.com/quangminh1212/XLab_Token"
        target="_blank"
        rel="noopener noreferrer"
      >
        <GitHubIcon />
        <GitHubBtnText>View on GitHub</GitHubBtnText>
      </GitHubBtn>
    </SectionWrapper>
  );
}

const SectionWrapper = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 48px;
  padding: 80px 24px;

  @media (max-width: 768px) {
    padding: 48px 16px;
    gap: 32px;
  }
`;

const DescriptionText = styled.p`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 700;
  font-size: 36px;
  line-height: 1.25em;
  letter-spacing: -0.025em;
  text-align: center;
  color: var(--color-fg-default);
  max-width: 680px;

  @media (max-width: 768px) {
    font-size: 26px;
  }

  @media (max-width: 480px) {
    font-size: 20px;
  }
`;

const GradientText = styled.span`
  background: linear-gradient(135deg, var(--color-primary) 0%, #00d4c8 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
`;

const FeaturesGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  width: 100%;
  max-width: 720px;

  @media (max-width: 640px) {
    grid-template-columns: 1fr;
  }
`;

const FeatureCard = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 24px;
  background: var(--color-canvas-default);
  border: 1px solid var(--color-border-default);
  border-radius: 16px;
  transition: all 0.2s;

  &:hover {
    border-color: color-mix(in srgb, var(--color-primary) 25%, var(--color-border-default));
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.04);
  }
`;

const FeatureTitle = styled.h3`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 700;
  font-size: 16px;
  color: var(--color-fg-default);
`;

const FeatureDesc = styled.p`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 400;
  font-size: 14px;
  line-height: 1.5em;
  color: var(--color-fg-muted);
`;

const GitHubBtn = styled.a`
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 12px 32px;
  background: var(--color-fg-default);
  border-radius: 100px;
  text-decoration: none;
  transition: all 0.2s;

  &:hover {
    opacity: 0.9;
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  }
`;

const GitHubIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 0C5.374 0 0 5.373 0 12C0 17.302 3.438 21.8 8.207 23.387C8.806 23.498 9 23.126 9 22.81V20.576C5.662 21.302 4.967 19.16 4.967 19.16C4.421 17.773 3.634 17.404 3.634 17.404C2.545 16.659 3.717 16.675 3.717 16.675C4.922 16.759 5.556 17.912 5.556 17.912C6.626 19.746 8.363 19.216 9.048 18.909C9.155 18.134 9.466 17.604 9.81 17.305C7.145 17 4.343 15.971 4.343 11.374C4.343 10.063 4.812 8.993 5.579 8.153C5.455 7.85 5.044 6.629 5.696 4.977C5.696 4.977 6.704 4.655 8.997 6.207C9.954 5.941 10.98 5.808 12 5.803C13.02 5.808 14.047 5.941 15.006 6.207C17.297 4.655 18.303 4.977 18.303 4.977C18.956 6.63 18.545 7.851 18.421 8.153C19.19 8.993 19.656 10.064 19.656 11.374C19.656 15.983 16.849 16.998 14.177 17.295C14.607 17.667 15 18.397 15 19.517V22.81C15 23.129 15.192 23.504 15.801 23.386C20.566 21.797 24 17.3 24 12C24 5.373 18.627 0 12 0Z" fill="var(--color-canvas-default)"/>
  </svg>
);

const GitHubBtnText = styled.span`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 700;
  font-size: 17px;
  color: var(--color-canvas-default);
`;
