import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";

import { TRPCReactProvider } from "@/trpc/react";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "EZiL OS",
  description: "Your computer, in your browser.",
};

/**
 * 🔴 `interactive-widget: overlays-content` — THE KEYBOARD MUST NOT MOVE THE
 * PAGE.
 *
 * Reported from a phone: raising the keyboard pushed the whole page up instead
 * of the window staying put and the keyboard floating over it. Served meta
 * before this was `width=device-width, initial-scale=1` with no
 * `interactive-widget` at all, so browsers used their default — on Android,
 * resizing the visual viewport and letting the page scroll. The OS shell then
 * slides under the keyboard, and the desktop the user is typing into goes with
 * it.
 *
 * `overlays-content` says the keyboard is an OVERLAY: the layout viewport does
 * not change, nothing reflows, nothing scrolls. That is the behaviour a shell
 * wants, and it is what `--ezil-kb` was already written for — `boot.js`
 * publishes the obscured height and the taskbar lifts itself clear, which only
 * works if the page underneath is holding still.
 *
 * `visualViewport` still reports the smaller height, so `--ezil-vvh` and
 * `--ezil-kb` keep working exactly as before; what changes is that the browser
 * stops moving the document out from under them.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "overlays-content",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <TRPCReactProvider>{children}</TRPCReactProvider>
        <Toaster theme="dark" richColors />
      </body>
    </html>
  );
}
