//! Puts the page `roer mcp` serves to apps that draw MCP Apps (`npm run build:mcp-app`, in `dist-mcp-app/`) into
//! the binary, so an installed roer serves extensions with no checkout beside it. A build without it still works,
//! and reads the page from the checkout at run time (`mcp_apps::runtime`); a release sets `ROER_REQUIRE_MCP_APP`
//! so that one without it fails here rather than ship.

use std::path::Path;

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("dist-mcp-app");
    let js = dir.join("runtime.js");
    let css = dir.join("runtime.css");
    println!("cargo:rerun-if-changed={}", js.display());
    println!("cargo:rerun-if-changed={}", css.display());
    println!("cargo:rerun-if-env-changed=ROER_REQUIRE_MCP_APP");
    println!("cargo::rustc-check-cfg=cfg(mcp_app)");
    if js.is_file() && css.is_file() {
        println!("cargo:rustc-cfg=mcp_app");
        println!("cargo:rustc-env=ROER_MCP_APP_JS={}", js.display());
        println!("cargo:rustc-env=ROER_MCP_APP_CSS={}", css.display());
    } else if std::env::var_os("ROER_REQUIRE_MCP_APP").is_some_and(|v| !v.is_empty()) {
        panic!("{} is missing: run `npm run build:mcp-app` before building roer for a release", js.display());
    }
}
