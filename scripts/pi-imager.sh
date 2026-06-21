export QT_STYLE_OVERRIDE="${PI_IMAGER_QT_STYLE_OVERRIDE:-fusion}"
export QT_QPA_PLATFORM="${PI_IMAGER_QT_QPA_PLATFORM:-wayland}"
exec rpi-imager "$@"
