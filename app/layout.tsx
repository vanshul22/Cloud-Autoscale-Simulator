import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// Sans for UI text, mono for numbers/IDs/clock. next/font self-hosts them and
// exposes CSS variables that globals.css reads (no layout shift, no external request).
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Cloud Autoscale Simulator",
  description:
    "An interactive simulator of cloud autoscaling: traffic, load balancing, instances and cost.",
};

// Tells mobile browsers the page is dark so scrollbars/form controls match.
export const viewport: Viewport = {
  themeColor: "#0b0f19",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // class="dark" switches on the `.dark` token set in globals.css (Tailwind darkMode: class).
    <html lang="en" className="dark">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
