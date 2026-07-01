"use client";

import styled from "styled-components";

export function DescriptionSection() {
  return (
    <SectionWrapper>
      <DescriptionText>
        A high-performance CLI tool and visualization dashboard for tracking
        token usage and costs across multiple AI coding agents.
      </DescriptionText>
      <GitHubBtn
        href="https://github.com/quangminh1212/XLab_Token"
        target="_blank"
        rel="noopener noreferrer"
      >
        <GitHubBtnText>GitHub</GitHubBtnText>
      </GitHubBtn>
    </SectionWrapper>
  );
}

const SectionWrapper = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 32px;
  padding: 80px 24px;

  @media (max-width: 768px) {
    padding: 48px 16px;
    gap: 24px;
  }
`;

const DescriptionText = styled.p`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 600;
  font-size: 32px;
  line-height: 1.3em;
  letter-spacing: -0.02em;
  text-align: center;
  color: var(--color-fg-muted);
  max-width: 640px;

  @media (max-width: 768px) {
    font-size: 24px;
  }

  @media (max-width: 480px) {
    font-size: 20px;
  }
`;

const GitHubBtn = styled.a`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 28px;
  background: var(--color-fg-default);
  border-radius: 100px;
  text-decoration: none;
  transition: opacity 0.15s;

  &:hover { opacity: 0.9; }
`;

const GitHubBtnText = styled.span`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 700;
  font-size: 18px;
  color: var(--color-canvas-default);
`;
