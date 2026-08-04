import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `exceljs` is only ever used by the import scripts (Node, outside Next), but if a
  // future server action wraps the importer this keeps it out of the bundler.
  serverExternalPackages: ['exceljs'],
};

export default nextConfig;
