import { Navigation } from "@/components/layout/Navigation";
import { Footer } from "@/components/layout/Footer";
import CreateGroupClient from "./CreateGroupClient";

export default async function NewGroupPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--color-bg-default)",
      }}
    >
      <Navigation />
      <main className="main-container">
        <CreateGroupClient />
      </main>
      <Footer />
    </div>
  );
}
