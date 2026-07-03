"use client";

import { useState, useEffect } from "react";
import styled from "styled-components";

const Container = styled.div`
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding-left: 16px;
  padding-right: 16px;
`;

const LoadingContainer = styled.div`
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
`;

const LoadingText = styled.div`
  color: var(--color-fg-muted);
`;

const CardWrapper = styled.div`
  max-width: 448px;
  width: 100%;
`;

const Card = styled.div`
  border-radius: 16px;
  border: 1px solid;
  border-color: var(--color-border-default);
  padding: 32px;
  background-color: var(--color-bg-default);
`;

const Header = styled.div`
  text-align: center;
  margin-bottom: 32px;
`;

const IconBox = styled.div`
  width: 64px;
  height: 64px;
  margin-left: auto;
  margin-right: auto;
  margin-bottom: 16px;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(to bottom right, #53d1f3, #3bc4e8);
  box-shadow: 0 10px 15px -3px rgba(83, 209, 243, 0.25);
`;

const Icon = styled.svg`
  width: 32px;
  height: 32px;
  color: white;
`;

const Title = styled.h1`
  font-size: 24px;
  font-weight: bold;
  color: var(--color-fg-default);
`;

const Subtitle = styled.p`
  margin-top: 8px;
  color: var(--color-fg-muted);
`;

const SignInContainer = styled.div`
  text-align: center;
`;

const SignInText = styled.p`
  margin-bottom: 24px;
  color: var(--color-fg-muted);
`;

const SignInButton = styled.a`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 24px;
  font-weight: 500;
  border-radius: 12px;
  background-color: var(--color-fg-default);
  color: var(--color-bg-default);
  transition: opacity 0.2s;
  text-decoration: none;

  &:hover {
    opacity: 0.8;
  }
`;

const GitHubIcon = styled.svg`
  width: 20px;
  height: 20px;
`;

const SuccessContainer = styled.div`
  text-align: center;
`;

const SuccessIconBox = styled.div`
  width: 64px;
  height: 64px;
  margin-left: auto;
  margin-right: auto;
  margin-bottom: 16px;
  border-radius: 9999px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: rgba(83, 209, 243, 0.1);
`;

const SuccessIcon = styled.svg`
  width: 32px;
  height: 32px;
  color: #53d1f3;
`;

const SuccessTitle = styled.h2`
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--color-fg-default);
`;

const SuccessText = styled.p`
  color: var(--color-fg-muted);
`;

const Form = styled.form``;

const FormGroup = styled.div`
  margin-bottom: 16px;
`;

const FormText = styled.p`
  text-align: center;
  margin-bottom: 16px;
  color: var(--color-fg-muted);
`;

const Input = styled.input`
  width: 100%;
  padding: 16px;
  text-align: center;
  font-size: 24px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  letter-spacing: 0.3em;
  border: 1px solid;
  border-color: var(--color-border-default);
  border-radius: 12px;
  background-color: var(--color-bg-elevated);
  color: var(--color-fg-default);

  &:focus {
    outline: none;
    box-shadow: 0 0 0 2px var(--color-primary);
    border-color: transparent;
  }

  &::placeholder {
    opacity: 0.5;
  }
`;

const ErrorText = styled.p`
  color: #ef4444;
  font-size: 14px;
  text-align: center;
  margin-bottom: 16px;
`;

const SubmitButton = styled.button`
  width: 100%;
  padding: 12px 24px;
  color: white;
  font-weight: 500;
  border-radius: 12px;
  background-color: var(--color-primary);
  border: none;
  cursor: pointer;
  transition: opacity 0.2s;

  &:hover:not(:disabled) {
    opacity: 0.9;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const UserInfoText = styled.p`
  text-align: center;
  font-size: 14px;
  margin-top: 16px;
  color: var(--color-fg-muted);
`;

const Username = styled.span`
  font-weight: 500;
  color: var(--color-fg-muted);
`;

export default function DeviceClient() {
  const [isLoading, setIsLoading] = useState(true);
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    setIsLoading(false);
  }, []);

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");

    if (value.length > 4) {
      value = value.slice(0, 4) + "-" + value.slice(4, 8);
    }

    setCode(value);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("loading");
    setError("");

    try {
      const response = await fetch("/api/auth/device/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCode: code }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Invalid code");
      }

      setStatus("success");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  };

  if (isLoading) {
    return (
      <LoadingContainer style={{ backgroundColor: "var(--color-bg-default)" }}>
        <LoadingText>Loading...</LoadingText>
      </LoadingContainer>
    );
  }

  return (
    <Container style={{ backgroundColor: "var(--color-bg-default)" }}>
      <CardWrapper>
        <Card>
          <Header>
            <IconBox>
              <Icon
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </Icon>
            </IconBox>
            <Title>Authorize CLI</Title>
            <Subtitle>Connect your terminal to XLab Token</Subtitle>
          </Header>

          {status === "success" ? (
            <SuccessContainer>
              <SuccessIconBox>
                <SuccessIcon
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </SuccessIcon>
              </SuccessIconBox>
              <SuccessTitle>Device Authorized!</SuccessTitle>
              <SuccessText>
                You can close this window and return to your terminal.
              </SuccessText>
            </SuccessContainer>
          ) : (
            <Form onSubmit={handleSubmit}>
              <FormGroup>
                <FormText>
                  Enter the code shown in your terminal:
                </FormText>
                <Input
                  type="text"
                  value={code}
                  onChange={handleCodeChange}
                  placeholder="XXXX-XXXX"
                  maxLength={9}
                  autoFocus
                />
              </FormGroup>

              {error && (
                <ErrorText>{error}</ErrorText>
              )}

              <SubmitButton
                type="submit"
                disabled={code.length < 9 || status === "loading"}
              >
                {status === "loading" ? "Authorizing..." : "Authorize Device"}
              </SubmitButton>
            </Form>
          )}
        </Card>
      </CardWrapper>
    </Container>
  );
}
