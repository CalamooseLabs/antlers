{pkgs ? import <nixpkgs> {}, ...}:
pkgs.stdenv.mkDerivation {
  name = "pdf";
  src = ./.;
  buildInputs = with pkgs; [
    texliveSmall
    pandoc
    sc-im
    expect
  ];
  buildPhase = ''
    mkdir -p .cache/markdown

    # Create an expect script to automate sc-im
    ${pkgs.expect}/bin/expect << 'EOF'
    set timeout 1
    spawn sc-im ./src/main.sc
    sleep 0.25
    send ":e mkd .cache/markdown/main.mkd\r"
    sleep 0.5
    send ":q!\r"
    expect eof
    EOF

    pandoc -s .cache/markdown/main.mkd -o main.pdf
  '';
  installPhase = ''
    mkdir -p $out
    cp main.pdf $out
  '';
}
