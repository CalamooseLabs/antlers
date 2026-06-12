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
}
