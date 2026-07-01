"use client";

import styled from "styled-components";

export function FollowSection() {
  return (
    <SectionWrapper>
      <HeadingText>
        I drop new open-source work every week.
        <br />
        Don't miss the next one.
      </HeadingText>
      <FollowLink
        href="https://github.com/junhoyeo"
        target="_blank"
        rel="noopener noreferrer"
      >
        Follow @junhoyeo on GitHub
      </FollowLink>
    </SectionWrapper>
  );
}

const SectionWrapper = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  padding: 80px 24px;

  @media (max-width: 768px) {
    padding: 48px 16px;
    gap: 16px;
  }
`;

const HeadingText = styled.p`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 700;
  font-size: 32px;
  line-height: 1.2em;
  letter-spacing: -0.02em;
  text-align: center;
  color: var(--color-primary);
  max-width: 560px;

  @media (max-width: 768px) {
    font-size: 24px;
  }

  @media (max-width: 480px) {
    font-size: 20px;
  }
`;

const FollowLink = styled.a`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 600;
  font-size: 20px;
  color: var(--color-fg-muted);
  text-decoration: none;
  transition: color 0.15s;

  &:hover { color: var(--color-fg-default); }

  @media (max-width: 480px) {
    font-size: 16px;
  }
`;
