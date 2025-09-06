{
  description = "GNOME Shell extension development with npm/yarn";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs
            nodePackages.pnpm

            # GNOME development
            pkgs.gnome-shell
            glib
          ];

          shellHook = ''
            echo "GNOME Shell development environment with Node.js package managers"
            echo ""
            echo "Available package managers:"
            echo "  pnpm $(pnpm --version)"
            echo ""
            echo "Quick start:"
            echo "  pnpm install @girs/gnome-shell @girs/meta-12 @girs/clutter-12 @girs/st-12"
          '';
        };
      });
}
