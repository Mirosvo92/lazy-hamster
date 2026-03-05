import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const katexVersion = require('katex/package.json').version;

/** @type {import('next').NextConfig} */
const nextConfig = {
    webpack(config, { webpack }) {
        config.plugins.push(
            new webpack.DefinePlugin({
                __VERSION__: JSON.stringify(katexVersion),
            }),
        );
        return config;
    },
};

export default nextConfig;
