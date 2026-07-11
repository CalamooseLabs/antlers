# programs.antlers-scripts — install the antlers script collection with overrides
# baked in, so you can just type `rebuild-config` / `sonarr-restore` / etc.
#
# Imported via either:
#   inputs.antlers.nixosModules.antlers-scripts        -> environment.systemPackages
#   inputs.antlers.homeManagerModules.antlers-scripts  -> home.packages
#
# Both expose the SAME option tree under `programs.antlers-scripts`. Each enabled
# script is wrapped with `makeWrapper --set-default VAR value`, which sets the
# configured value as the binary's default while still letting a runtime env var
# (e.g. `CONFIG_PATH=… rebuild-config`) take precedence.
#
# `location` selects where the packages land: "system" or "home".
location: {
  # A stable `key` so this module DEDUPLICATES when imported by many shims for the
  # same user/host (every rebuild-config / edit-config / … shim imports it).
  # Without it the option set is declared once per importer → "already declared".
  _file = "antlers/flakes/scripts/module.nix";
  key = "antlers-scripts-${location}";
  imports = [
    (
      {
        config,
        lib,
        pkgs,
        ...
      }:
        with lib; let
          cfg = config.programs.antlers-scripts;
          scripts = pkgs.callPackages ./package.nix {};

          strOpt = default:
            mkOption {
              type = types.str;
              inherit default;
            };
          scriptModule = extra:
            mkOption {
              default = {};
              type = types.submodule {options = {enable = mkEnableOption "this script";} // extra;};
            };

          # Wrap a script with baked-in env defaults. `env` is a list of {name; value;}
          # to --set-default; entries are dropped when value is empty so the script's own
          # built-in default applies. With no env and no rename, the bare package is used.
          wrap = {
            pkg,
            bin ? pkg,
            env ? [],
          }: let
            keep = filter (e: e.value != "") env;
            flags = concatMapStringsSep " " (e: "--set-default ${e.name} ${escapeShellArg e.value}") keep;
          in
            if keep == [] && bin == pkg
            then scripts.${pkg}
            else
              pkgs.runCommandLocal bin {
                nativeBuildInputs = [pkgs.makeWrapper];
                meta = scripts.${pkg}.meta or {};
              } ''
                makeWrapper ${scripts.${pkg}}/bin/${pkg} $out/bin/${bin} ${flags}
              '';

          # --- structured renderings ---
          repoMap = concatStringsSep "\n" (mapAttrsToList (ref: dir: "${ref} ${dir}") cfg.github-repo-puller.repos);
          kvmTargets = concatStringsSep "\n" (mapAttrsToList (n: t: "${n} ${t.dns} ${t.ip}") cfg.remote-kvm.targets);

          plexEnv = [
            {
              name = "PLEX_DATA_DIR";
              value = cfg.plex.dataDir;
            }
            {
              name = "BACKUP_DIR";
              value = cfg.plex.backupDir;
            }
            {
              name = "PLEX_USER";
              value = cfg.plex.user;
            }
            {
              name = "PLEX_GROUP";
              value = cfg.plex.group;
            }
            {
              name = "PLEX_PRIMARY_DB";
              value = cfg.plex.primaryDb;
            }
            {
              name = "PLEX_BLOBS_DB";
              value = cfg.plex.blobsDb;
            }
          ];

          packages =
            (optional cfg.rebuild-config.enable (wrap {
              pkg = "rebuild-config";
              env = [
                {
                  name = "CONFIG_PATH";
                  value = cfg.rebuild-config.configPath;
                }
              ];
            }))
            ++ (optional cfg.remote-build.enable (wrap {
              pkg = "remote-build";
              env = [
                {
                  name = "REMOTE_BUILD_PATH";
                  value = cfg.remote-build.configPath;
                }
              ];
            }))
            ++ (optional cfg.edit-config.enable (wrap {
              pkg = "edit-config";
              env = [
                {
                  name = "EDIT_CONFIG_DIR";
                  value = cfg.edit-config.configDir;
                }
              ];
            }))
            ++ (optional cfg.restore-config.enable (wrap {
              pkg = "restore-config";
              env = [
                {
                  name = "RESTORE_CONFIG_PATH";
                  value = cfg.restore-config.configPath;
                }
              ];
            }))
            ++ (optional cfg.ssh-key-import.enable (wrap {
              pkg = "ssh-key-import";
              env = [
                {
                  name = "SSH_KEY_NAME";
                  value = cfg.ssh-key-import.keyName;
                }
              ];
            }))
            ++ (optional cfg.chromium-ephemeral.enable (wrap {
              pkg = "chromium-ephemeral";
              env = [
                {
                  name = "CHROMIUM_EPHEMERAL_BIN";
                  value = cfg.chromium-ephemeral.binary;
                }
              ];
            }))
            ++ (optional cfg.pi-imager.enable (wrap {
              pkg = "pi-imager";
              env = [
                {
                  name = "PI_IMAGER_QT_STYLE_OVERRIDE";
                  value = cfg.pi-imager.qtStyleOverride;
                }
                {
                  name = "PI_IMAGER_QT_QPA_PLATFORM";
                  value = cfg.pi-imager.qtQpaPlatform;
                }
              ];
            }))
            ++ (optional cfg.gpg-key-import.enable (wrap {
              pkg = "gpg-key-import";
              env = [
                {
                  name = "GPG_KEY_FILE";
                  value = cfg.gpg-key-import.keyFile;
                }
                {
                  name = "GPG_KEY_ID";
                  value = cfg.gpg-key-import.keyId;
                }
              ];
            }))
            ++ (optional cfg.yubikey-provision.enable (wrap {
              pkg = "yubikey-provision";
              env = [
                {
                  name = "PIV_SLOT";
                  value = cfg.yubikey-provision.slot;
                }
                {
                  name = "PIV_PIN_POLICY";
                  value = cfg.yubikey-provision.pinPolicy;
                }
                {
                  name = "PIV_TOUCH_POLICY";
                  value = cfg.yubikey-provision.touchPolicy;
                }
                {
                  name = "PIV_ALGO";
                  value = cfg.yubikey-provision.algo;
                }
                {
                  name = "GPG_ALGO";
                  value = cfg.yubikey-provision.gpgAlgo;
                }
                {
                  name = "GPG_EXPIRE";
                  value = cfg.yubikey-provision.gpgExpire;
                }
                {
                  name = "GPG_TOUCH";
                  value = cfg.yubikey-provision.gpgTouch;
                }
                {
                  name = "CONFIG_PATH";
                  value = cfg.yubikey-provision.configPath;
                }
              ];
            }))
            ++ (optional cfg.yubikey-github-bootstrap.enable (wrap {
              pkg = "yubikey-github-bootstrap";
              env = [
                {
                  name = "GPG_NAME";
                  value = cfg.yubikey-github-bootstrap.gpgName;
                }
                {
                  name = "GPG_EMAIL";
                  value = cfg.yubikey-github-bootstrap.gpgEmail;
                }
                {
                  name = "GPG_ALGO";
                  value = cfg.yubikey-github-bootstrap.gpgAlgo;
                }
                {
                  name = "GPG_EXPIRE";
                  value = cfg.yubikey-github-bootstrap.gpgExpire;
                }
                {
                  name = "PROTON_VAULT";
                  value = cfg.yubikey-github-bootstrap.protonVault;
                }
                {
                  name = "PROTON_ITEM";
                  value = cfg.yubikey-github-bootstrap.protonItem;
                }
                {
                  name = "CONFIG_PATH";
                  value = cfg.yubikey-github-bootstrap.configPath;
                }
              ];
            }))
            ++ (optional cfg.bridge-internet.enable (wrap {
              pkg = "bridge-internet";
              env = [
                {
                  name = "BRIDGE_IP_RANGE";
                  value = cfg.bridge-internet.ipRange;
                }
                {
                  name = "BRIDGE_NETMASK";
                  value = cfg.bridge-internet.netmask;
                }
                {
                  name = "BRIDGE_LEASE_TIME";
                  value = cfg.bridge-internet.leaseTime;
                }
                {
                  name = "BRIDGE_DHCP_PORT";
                  value = toString cfg.bridge-internet.dhcpPort;
                }
              ];
            }))
            ++ (optional cfg.flash-iso.enable (wrap {
              pkg = "flash-iso";
              env = [
                {
                  name = "FLASH_ISO_FLAKE";
                  value = cfg.flash-iso.flake;
                } # dropped when "" -> git-toplevel autodetect
                {
                  name = "FLASH_ISO_ATTR";
                  value = cfg.flash-iso.attr;
                }
                {
                  name = "FLASH_ISO_TITLE";
                  value = cfg.flash-iso.title;
                }
              ];
            }))
            ++ (optional cfg.install-cala-m-os.enable (wrap {
              pkg = "install-cala-m-os";
              env = [
                {
                  name = "INSTALL_FLAKE_REF";
                  value = cfg.install-cala-m-os.flakeRef;
                }
                {
                  name = "INSTALL_CLONE_URL";
                  value = cfg.install-cala-m-os.cloneUrl;
                }
                {
                  name = "INSTALL_VERSION_ATTR";
                  value = cfg.install-cala-m-os.versionAttr;
                }
                {
                  name = "INSTALL_TARGET_DIR";
                  value = cfg.install-cala-m-os.targetDir;
                }
                {
                  name = "INSTALL_MNT_DIR";
                  value = cfg.install-cala-m-os.mntDir;
                }
                {
                  name = "INSTALL_PREFETCH_REL";
                  value = cfg.install-cala-m-os.prefetchRel;
                }
                {
                  name = "INSTALL_PASSWD_USERS";
                  value = concatStringsSep " " cfg.install-cala-m-os.passwdUsers;
                }
              ];
            }))
            ++ (optional cfg.github-repo-puller.enable (wrap {
              pkg = "github-repo-puller";
              env = [
                {
                  name = "REPO_MAP";
                  value = repoMap;
                }
                {
                  name = "GITHUB_API";
                  value = cfg.github-repo-puller.githubApi;
                }
                {
                  name = "GITHUB_TOKEN";
                  value = optionalString (cfg.github-repo-puller.githubToken != null) cfg.github-repo-puller.githubToken;
                }
              ];
            }))
            ++ (optional cfg.remote-kvm.enable (wrap {
              pkg = "remote-kvm";
              env = [
                {
                  name = "REMOTE_KVM_TARGETS";
                  value = kvmTargets;
                }
                {
                  name = "REMOTE_KVM_DEFAULT";
                  value = cfg.remote-kvm.defaultTarget;
                }
                {
                  name = "REMOTE_KVM_PROFILE_DIR";
                  value = cfg.remote-kvm.profileDir;
                }
              ];
            }))
            ++ (mapAttrsToList (_: i:
              wrap {
                pkg = "arr-restore";
                bin = "${i.app}-restore";
                env = [
                  {
                    name = "ARR_APP";
                    value = i.app;
                  }
                  {
                    name = "ARR_PORT";
                    value = toString i.port;
                  }
                  {
                    name = "ARR_DATA_DIR";
                    value = i.dataDir;
                  }
                  {
                    name = "ARR_BACKUP_DIR";
                    value = i.backupDir;
                  }
                  {
                    name = "ARR_DB";
                    value = i.db;
                  }
                  {
                    name = "ARR_SERVICE";
                    value = i.service;
                  }
                ];
              })
            cfg.arr-restore.instances)
            ++ (optional cfg.plex.backup.enable (wrap {
              pkg = "plex-backup";
              env =
                plexEnv
                ++ [
                  {
                    name = "PLEX_RETENTION";
                    value = toString cfg.plex.retention;
                  }
                ];
            }))
            ++ (optional cfg.plex.restore.enable (wrap {
              pkg = "plex-restore";
              env =
                plexEnv
                ++ [
                  {
                    name = "PLEX_SERVICE";
                    value = cfg.plex.service;
                  }
                  {
                    name = "PLEX_PORT";
                    value = toString cfg.plex.port;
                  }
                ];
            }));
        in {
          options.programs.antlers-scripts = {
            enable = mkEnableOption "the antlers reusable script collection";

            rebuild-config = scriptModule {configPath = strOpt "/etc/nixos";};
            remote-build = scriptModule {configPath = strOpt "/etc/nixos";};
            edit-config = scriptModule {configDir = strOpt "/etc/nixos";};
            restore-config = scriptModule {configPath = strOpt "/etc/nixos";};
            ssh-key-import = scriptModule {keyName = strOpt "id_ed25519_sk";};
            chromium-ephemeral = scriptModule {binary = strOpt "chromium";};
            pi-imager = scriptModule {
              qtStyleOverride = strOpt "fusion";
              qtQpaPlatform = strOpt "wayland";
            };
            gpg-key-import = scriptModule {
              keyFile = strOpt "/run/agenix/yubigpg.asc";
              keyId = strOpt "50D56BF0B93CA212";
            };
            yubikey-provision = scriptModule {
              slot = strOpt "9a"; # PIV slot for the generated SSH key
              pinPolicy = strOpt "once";
              touchPolicy = strOpt "cached";
              algo = strOpt "auto"; # PIV key algorithm; auto => ED25519 (fw>=5.7) else ECCP256
              gpgAlgo = strOpt "auto"; # OpenPGP key algorithm; auto => 25519 (fw>=5.2.3) else rsa2048
              gpgExpire = strOpt "0"; # OpenPGP key expiry; 0 => never
              gpgTouch = strOpt "cached"; # signature-key touch policy (ykman openpgp set-touch)
              configPath = strOpt "/etc/nixos";
            };
            yubikey-github-bootstrap = scriptModule {
              gpgName = strOpt ""; # OpenPGP user-ID name; "" => git user.name / prompt
              gpgEmail = strOpt ""; # OpenPGP user-ID email; "" => git user.email / prompt
              gpgAlgo = strOpt "auto"; # OpenPGP key algorithm; auto => 25519 (fw>=5.2.3) else rsa2048
              gpgExpire = strOpt "0"; # OpenPGP key expiry; 0 => never
              protonVault = strOpt "Cala-M-OS"; # Proton Pass vault holding the public key
              protonItem = strOpt "ai-github-gpg.asc"; # Proton Pass item title (field is "secret")
              configPath = strOpt "/etc/nixos";
            };
            bridge-internet = scriptModule {
              ipRange = strOpt "10.0.0";
              netmask = strOpt "24";
              leaseTime = strOpt "24h";
              dhcpPort = mkOption {
                type = types.port;
                default = 5353;
              };
            };
            flash-iso = scriptModule {
              flake = strOpt ""; # "" => keep the script's git-toplevel autodetect default
              attr = strOpt "nixosConfigurations.iso.config.system.build.isoImage";
              title = strOpt "Cala-M-OS";
            };
            install-cala-m-os = scriptModule {
              flakeRef = strOpt "github:CalamooseLabs/cala-m-os";
              cloneUrl = strOpt "https://github.com/calamooselabs/cala-m-os.git";
              versionAttr = strOpt "calamoose.version";
              targetDir = strOpt "/etc/nixos";
              mntDir = strOpt "/mnt/etc/nixos";
              prefetchRel = strOpt "prefetch/displaylink-620.zip";
              passwdUsers = mkOption {
                type = types.listOf types.str;
                default = ["hub" "root"];
              };
            };

            github-repo-puller = scriptModule {
              repos = mkOption {
                type = types.attrsOf types.str;
                default = {};
                example = {"github:CalamooseLabs/OpenReturn" = "/home/hub/nkc";};
                description = "Map of `github:Owner[/Repo]` -> parent folder to clone/update into.";
              };
              githubApi = strOpt "https://api.github.com";
              githubToken = mkOption {
                type = types.nullOr types.str;
                default = null;
                description = "Optional GitHub token baked as the default; prefer supplying via env/agenix.";
              };
            };

            remote-kvm = scriptModule {
              targets = mkOption {
                default = {};
                type = types.attrsOf (types.submodule {
                  options = {
                    dns = mkOption {type = types.str;};
                    ip = mkOption {type = types.str;};
                  };
                });
                example = {
                  homelab = {
                    dns = "http://kvm.example/";
                    ip = "http://10.0.0.5/";
                  };
                };
                description = "Named KVM targets; the DNS URL is probed first, the IP URL is the off-network fallback.";
              };
              defaultTarget = strOpt "broadcast";
              profileDir = strOpt ""; # "" => script default $HOME/.local/share/remote-kvm
            };

            arr-restore.instances = mkOption {
              default = {};
              description = "One <app>-restore command per Servarr app.";
              type = types.attrsOf (types.submodule ({name, ...}: {
                options = {
                  app = mkOption {
                    type = types.str;
                    default = name;
                  };
                  port = mkOption {type = types.port;};
                  dataDir = mkOption {type = types.str;};
                  backupDir = mkOption {type = types.str;};
                  db = mkOption {
                    type = types.str;
                    default = ""; # "" => <app>.db
                  };
                  service = mkOption {
                    type = types.str;
                    default = ""; # "" => <app>.service
                  };
                };
              }));
            };

            plex = mkOption {
              default = {};
              type = types.submodule {
                options = {
                  backup.enable = mkEnableOption "the plex-backup command";
                  restore.enable = mkEnableOption "the plex-restore command";
                  dataDir = strOpt "/var/lib/plex";
                  backupDir = strOpt "/mnt/backup";
                  user = strOpt "plex";
                  group = strOpt "plex";
                  service = strOpt "plex.service";
                  port = mkOption {
                    type = types.port;
                    default = 32400;
                  };
                  primaryDb = strOpt "com.plexapp.plugins.library.db";
                  blobsDb = strOpt "com.plexapp.plugins.library.blobs.db";
                  retention = mkOption {
                    type = types.int;
                    default = 7;
                  };
                };
              };
            };
          };

          config = mkIf cfg.enable (
            if location == "home"
            then {home.packages = packages;}
            else {environment.systemPackages = packages;}
          );
        }
    )
  ];
}
