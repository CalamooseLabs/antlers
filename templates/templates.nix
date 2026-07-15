{
  dev-shell = {
    path = ./dev-shell;
    description = "a simple direnv nix flake shell";
    welcomeText = ''
      # Nix Dev Shell Template
    '';
  };

  zed-editor-shell = {
    path = ./zed-editor-shell;
    description = "a simple direnv zed editor flake shell";
    welcomeText = ''
      # Zed Dev Shell Template
    '';
  };

  vibe-shell = {
    path = ./vibe-shell;
    description = "a direnv nix flake shell with Claude Code + signed-commit (gcommit) and wiki helpers";
    welcomeText = ''
      # Vibe Shell Template (Claude Code)

      Run `direnv allow` (or `nix develop`) to enter the shell.

      Helpers:
        gcommit       review + sign + commit GIT_COMMIT_MSG (then optional signed tag)
        build-wiki    preview docs/ -> ./wiki-build
        publish-wiki  publish docs/ -> the repo's GitHub wiki

      See CLAUDE.md for the signed-commit workflow.
    '';
  };

  spreadsheet-pdf = {
    path = ./spreadsheet-pdf;
    description = "Spreadsheet to PDF template in SC-IM";
    welcomeText = ''
      Ensure to run direnv allow
    '';
  };

  nkc-farmland-lease = {
    path = ./nkc-farmland-lease;
    description = "Farmland Master Lease template in LaTeX";
    welcomeText = ''
      Ensure to run direnv allow
    '';
  };

  tex-editor = {
    path = ./tex-editor;
    description = "LaTeX document creator";
    welcomeText = ''
      Ensure to run direnv allow
    '';
  };

  nkc-lease-amendment = {
    path = ./nkc-lease-amendment;
    description = "Lease Amendment template in LaTeX";
    welcomeText = ''
      Ensure to run direnv allow
    '';
  };

  nkc-report = {
    path = ./nkc-report;
    description = "Document template in LaTeX";
    welcomeText = ''
      Ensure to run direnv allow
    '';
  };

  nkc-master-lease = {
    path = ./nkc-master-lease;
    description = "Commercial Master Lease builder with the create-lease wizard (LaTeX)";
    welcomeText = ''
      Ensure to run direnv allow, then run `create-lease` to fill in the deal.
    '';
  };

  # ---- The Company, Inc. corporate documents (create-doc wizard, shared style) ----
  thecompanyinc-annual-board-memo = {
    path = ./thecompanyinc-annual-board-memo;
    description = "The Company, Inc. — Annual Board Memo (Memorandum of Annual Action of Directors)";
    welcomeText = ''
      Run direnv allow, then `create-doc` to fill in the memo. `nix build` -> result/main.pdf.
    '';
  };

  thecompanyinc-annual-shareholder-memo = {
    path = ./thecompanyinc-annual-shareholder-memo;
    description = "The Company, Inc. — Annual Shareholder Memo (Memorandum of Annual Action of Shareholders)";
    welcomeText = ''
      Run direnv allow, then `create-doc` to fill in the memo. `nix build` -> result/main.pdf.
    '';
  };

  thecompanyinc-authentication-record-book = {
    path = ./thecompanyinc-authentication-record-book;
    description = "The Company, Inc. — Authentication of Record Book and Records";
    welcomeText = ''
      Run direnv allow, then `create-doc` to fill in the certificate. `nix build` -> result/main.pdf.
    '';
  };

  thecompanyinc-memorandum-board = {
    path = ./thecompanyinc-memorandum-board;
    description = "The Company, Inc. — Memorandum of Action of Directors (organizational board consent)";
    welcomeText = ''
      Run direnv allow, then `create-doc` to fill in / toggle resolutions. `nix build` -> result/main.pdf.
    '';
  };

  thecompanyinc-memorandum-shareholders = {
    path = ./thecompanyinc-memorandum-shareholders;
    description = "The Company, Inc. — Memorandum of Action by Shareholders (organizational consent)";
    welcomeText = ''
      Run direnv allow, then `create-doc` to fill in / toggle resolutions. `nix build` -> result/main.pdf.
    '';
  };

  thecompanyinc-bill-of-sale = {
    path = ./thecompanyinc-bill-of-sale;
    description = "The Company, Inc. — Bill of Sale and Assignment of Assets (create-doc wizard)";
    welcomeText = ''
      Run direnv allow, then `create-doc` to fill in the deal. `nix build` -> result/main.pdf.
    '';
  };

  thecompanyinc-ip-license = {
    path = ./thecompanyinc-ip-license;
    description = "The Company, Inc. — Intellectual Property License Agreement (create-doc wizard)";
    welcomeText = ''
      Run direnv allow, then `create-doc` to fill in the license. `nix build` -> result/main.pdf.
    '';
  };

  thecompanyinc-promissory-note = {
    path = ./thecompanyinc-promissory-note;
    description = "The Company, Inc. — Promissory Note (buy-sell note, from the Shareholders Agreement Schedule A)";
    welcomeText = ''
      Run direnv allow, then `create-doc` to fill in the note. `nix build` -> result/main.pdf.
    '';
  };

  thecompanyinc-bylaws-amendment = {
    path = ./thecompanyinc-bylaws-amendment;
    description = "The Company, Inc. — Amendment to Bylaws (create-doc wizard)";
    welcomeText = ''
      Run direnv allow, then `create-doc` to fill in the amendment. `nix build` -> result/main.pdf.
    '';
  };

  thecompanyinc-shareholder-agreement-amendment = {
    path = ./thecompanyinc-shareholder-agreement-amendment;
    description = "The Company, Inc. — Amendment to Shareholders Agreement (create-doc wizard)";
    welcomeText = ''
      Run direnv allow, then `create-doc` to fill in the amendment. `nix build` -> result/main.pdf.
    '';
  };
}
