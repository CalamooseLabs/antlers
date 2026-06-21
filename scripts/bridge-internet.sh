# Help function
show_help() {
    echo "Usage: $0 -i <internet_device> -e <ethernet_device> [-r <ip_range>] [-n <netmask>] [-t <lease_time>]"
    echo
    echo "Options:"
    echo "  -i  Internet device (required, e.g., wlan0, enp0s13f0u1)"
    echo "  -e  Ethernet device (required, e.g., eth0, enp0s20f0u5c4i2)"
    echo "  -r  IP range (optional, default: ${BRIDGE_IP_RANGE:-10.0.0})"
    echo "  -n  Netmask (optional, default: ${BRIDGE_NETMASK:-24})"
    echo "  -t  DHCP lease time (optional, default: ${BRIDGE_LEASE_TIME:-24h})"
    echo "  -h  Show this help message"
    echo
    echo "Example: $0 -i wlan0 -e eth0"
    exit 1
}

# Default configuration variables (overridable via environment)
IP_RANGE="${BRIDGE_IP_RANGE:-10.0.0}"
NETMASK="${BRIDGE_NETMASK:-24}"
LEASE_TIME="${BRIDGE_LEASE_TIME:-24h}"
DHCP_PORT="${BRIDGE_DHCP_PORT:-5353}"  # Alternative port for dnsmasq

# Variables populated later; initialized for nounset safety
INTERNET_DEVICE=""
ETHERNET_DEVICE=""
DNSMASQ_PID=""
CREATED_NAT_TABLE=""

# Parse command-line arguments
while getopts "i:e:r:n:t:h" opt; do
    case "$opt" in
        i) INTERNET_DEVICE="$OPTARG" ;;
        e) ETHERNET_DEVICE="$OPTARG" ;;
        r) IP_RANGE="$OPTARG" ;;
        n) NETMASK="$OPTARG" ;;
        t) LEASE_TIME="$OPTARG" ;;
        h) show_help ;;
        *) show_help ;;
    esac
done

# Check if the script is run as root
if [ "$EUID" -ne 0 ]; then
  echo "This script must be run as root. Please use sudo."
  exit 1
fi

# Check if required arguments are provided
if [ -z "$INTERNET_DEVICE" ] || [ -z "$ETHERNET_DEVICE" ]; then
    echo "Error: Both internet device and ethernet device must be specified."
    show_help
fi

# Check if devices exist
if ! ip link show "$INTERNET_DEVICE" &>/dev/null; then
    echo "Error: Internet device $INTERNET_DEVICE does not exist."
    exit 1
fi

if ! ip link show "$ETHERNET_DEVICE" &>/dev/null; then
    echo "Error: Ethernet device $ETHERNET_DEVICE does not exist."
    exit 1
fi

# Function to clean up on exit
cleanup() {
    echo "Cleaning up..."

    # Kill dnsmasq
    if [ -n "$DNSMASQ_PID" ]; then
        kill "$DNSMASQ_PID"
    fi

    # Remove IP address
    ip addr del "${IP_RANGE}.1/${NETMASK}" dev "$ETHERNET_DEVICE"

    # Set interface down
    ip link set down "$ETHERNET_DEVICE"

    # Remove NAT rule and table if we created them
    if [ -n "$CREATED_NAT_TABLE" ]; then
        nft delete table ip nat
    else
        # Try to remove just our rule if the table existed before
        HANDLE=$(nft -a list table ip nat | grep "oifname \"$INTERNET_DEVICE\" masquerade" | awk '{print $NF}')
        if [ -n "$HANDLE" ]; then
            nft delete rule ip nat POSTROUTING handle "$HANDLE"
        fi
    fi

    # Disable packet forwarding
    sysctl net.ipv4.ip_forward=0

    echo "Cleanup complete"
    exit 0
}

# Set up trap to call cleanup function on script termination
trap cleanup INT TERM EXIT

echo "Setting up internet sharing from $INTERNET_DEVICE to $ETHERNET_DEVICE..."

# Setup ethernet device
ip link set up "$ETHERNET_DEVICE"
ip addr add "${IP_RANGE}.1/${NETMASK}" dev "$ETHERNET_DEVICE"

# Check if NAT table exists, create if not
if ! nft list tables | grep -q "table ip nat"; then
    echo "Creating NAT table..."
    nft add table ip nat
    # shellcheck disable=SC1083  # the { ... } and \; are literal nft syntax, not shell
    nft add chain ip nat POSTROUTING { type nat hook postrouting priority 100 \; }
    CREATED_NAT_TABLE=1
fi

# Enable NAT for leaving packets
nft add rule nat POSTROUTING oifname "$INTERNET_DEVICE" masquerade

# Start dnsmasq for DHCP (using alternative port)
dnsmasq -d -i "$ETHERNET_DEVICE" --dhcp-range="${IP_RANGE}.2,${IP_RANGE}.255,255.255.255.0,$LEASE_TIME" --port="$DHCP_PORT" &
DNSMASQ_PID=$!

echo "Internet sharing active. Press Ctrl+C to stop and clean up."
echo "Clients can connect to the ethernet port and will receive IP addresses in the ${IP_RANGE}.0/${NETMASK} range."
echo "DHCP server running on port $DHCP_PORT"

# Keep script running until interrupted
while true; do
    sleep 1
done
