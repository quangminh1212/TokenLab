"use client";

import styled from "styled-components";

export function FollowSection() {
  return (
    <SectionWrapper>
      <FollowCard>
        <HeadingText>
          I drop new open-source work every week.
          <br />
          <AccentText>Don't miss the next one.</AccentText>
        </HeadingText>
        <FollowLink
          href="https://github.com/quangminh1212"
          target="_blank"
          rel="noopener noreferrer"
        >
          <GitHubMiniIcon />
          Follow @quangminh1212
        </FollowLink>
      </FollowCard>
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

const FollowCard = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 28px;
  padding: 48px 40px;
  background: linear-gradient(135deg, var(--color-badge-bg) 0%, var(--color-canvas-subtle) 100%);
  border: 1px solid color-mix(in srgb, var(--color-primary) 15%, transparent);
  border-radius: 24px;
  max-width: 640px;
  width: 100%;
  text-align: center;

  @media (max-width: 480px) {
    padding: 32px 20px;
    gap: 20px;
  }
`;

const HeadingText = styled.p`
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 700;
  font-size: 28px;
  line-height: 1.25em;
  letter-spacing: -0.02em;
  text-align: center;
  color: var(--color-fg-default);

  @media (max-width: 768px) {
    font-size: 22px;
  }

  @media (max-width: 480px) {
    font-size: 18px;
  }
`;

const AccentText = styled.span`
  background: linear-gradient(135deg, var(--color-primary) 0%, #00d4c8 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
`;

const FollowLink = styled.a`
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-figtree), "Figtree", sans-serif;
  font-weight: 700;
  font-size: 16px;
  color: #ffffff;
  background: var(--color-fg-default);
  padding: 12px 28px;
  border-radius: 100px;
  text-decoration: none;
  transition: all 0.2s;

  &:hover {
    color: #ffffff;
    opacity: 0.9;
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  }

  @media (max-width: 480px) {
    font-size: 14px;
    padding: 10px 22px;
  }
`;

const GitHubMiniIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 0C5.374 0 0 5.373 0 12C0 17.302 3.438 21.8 8.207 23.387C8.806 23.498 9 23.126 9 22.81V20.576C5.662 21.302 4.967 19.16 4.967 19.16C4.421 17.773 3.634 17.404 3.634 17.404C2.545 16.659 3.717 16.675 3.717 16.675C4.922 16.759 5.556 17.912 5.556 17.912C6.626 19.746 8.363 19.216 9.048 18.909C9.155 18.134 9.466 17.604 9.81 17.305C7.145 17 4.343 15.971 4.343 11.374C4.343 10.063 4.812 8.993 5.579 8.153C5.455 7.85 5.044 6.629 5.696 4.977C5.696 4.977 6.704 4.655 8.997 6.207C9.954 5.941 10.98 5.808 12 5.803C13.02 5.808 14.047 5.941 15.006 6.207C17.297 4.655 18.303 4.977 18.303 4.977C18.956 6.63 18.545 7.851 18.421 8.153C19.19 8.993 19.656 10.064 19.656 11.374C19.656 15.983 16.849 16.998 14.177 17.295C14.607 17.667 15 18.397 15 19.517V22.81C15 23.129 15.192 23.504 15.801 23.386C20.566 21.797 24 17.3 24 12C24 5.373 18.627 0 12 0Z" fill="currentColor"/>
  </svg>
);
