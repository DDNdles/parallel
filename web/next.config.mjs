/** @type {import('next').NextConfig} */
const nextConfig = {
  // 静态导出：内核（node bin/parallel.js）直接托管 out/ 产物，运行时零 npm
  output: 'export',
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
