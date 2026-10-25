import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    // Both providers use per-desktop labels under these managed preview
    // zones. Permissions-Policy supports a whole wildcard label, not a
    // partial label such as *-nekodesktop. The iframe further scopes this
    // delegation to its src; the browser still asks for normal permission.
    const desktopOrigins = 'self "https://*.ezil.org" "https://*.ezil.work"';
    return [{
      source: '/:path*',
      headers: [{
        key: 'Permissions-Policy',
        value: `clipboard-read=(${desktopOrigins}), clipboard-write=(${desktopOrigins})`,
      }],
    }];
  },
};

export default nextConfig;
