'use strict';

const RELEASE_PLATFORMS = ['linux/amd64', 'linux/arm64'];
const SUPPORTED_RUNTIMES = ['docker', 'podman'];

function createReleaseMetadata(options = {}) {
    const packageMetadata = options.packageMetadata || {};
    const toolManifest = options.toolManifest || {};
    return {
        schemaVersion: 1,
        npm: {
            name: String(packageMetadata.name || ''),
            version: String(packageMetadata.version || ''),
            integrity: options.npmIntegrity ? String(options.npmIntegrity) : null
        },
        image: {
            repository: String(options.imageRepository || ''),
            version: String(packageMetadata.imageVersion || ''),
            digest: options.imageDigest ? String(options.imageDigest) : null,
            platforms: RELEASE_PLATFORMS.slice()
        },
        toolManifest: {
            schemaVersion: Number(toolManifest.schemaVersion || 0),
            sha256: String(options.toolManifestSha256 || '')
        },
        compatibility: {
            node: String(packageMetadata.engines && packageMetadata.engines.node || ''),
            runtimes: SUPPORTED_RUNTIMES.slice(),
            platforms: RELEASE_PLATFORMS.slice()
        }
    };
}

module.exports = { createReleaseMetadata };
