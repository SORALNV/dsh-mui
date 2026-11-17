#!/usr/bin/env python3
"""Headless pty driver: run a command under a pseudo-terminal.

- Output of the command (with \r\n) is appended to the log file.
- Lines written to the FIFO (one per line, \n -> \r) are sent to the command's stdin.
- Sets a 50x200 window size so TUIs render sanely.
"""
import os, pty, sys, struct, fcntl, termios, threading, signal, time

CMD = sys.argv[1:]
LOG = os.environ.get('MUI_PTY_LOG', '/tmp/mui-tui.log')
FIFO = os.environ.get('MUI_PTY_FIFO', '/tmp/mui-in')

def main():
    pid, master = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.environ['COLORTERM'] = 'truecolor'
        os.execvp(CMD[0], CMD)
    # parent
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 200, 0, 0))
    log = open(LOG, 'ab', buffering=0)

    def pump_output():
        while True:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            log.write(data)
        log.write(b'\n[pty-driver: child closed]\n')

    def pump_input():
        import select
        while True:
            try:
                fd = os.open(FIFO, os.O_RDONLY | os.O_NONBLOCK)
            except FileNotFoundError:
                time.sleep(0.5); continue
            while True:
                r, _, _ = select.select([fd], [], [], 0.5)
                if not r:
                    continue
                try:
                    data = os.read(fd, 4096)
                except BlockingIOError:
                    continue
                except OSError:
                    break
                if not data:  # all writers closed; reopen
                    break
                try:
                    os.write(master, data)
                except OSError:
                    return
            os.close(fd)

    t1 = threading.Thread(target=pump_output, daemon=True)
    t2 = threading.Thread(target=pump_input, daemon=True)
    t1.start(); t2.start()

    def on_term(signum, frame):
        try: os.kill(pid, signal.SIGTERM)
        except ProcessLookupError: pass
    signal.signal(signal.SIGTERM, on_term)

    while True:
        try:
            wpid, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            break
        if wpid == pid:
            log.write(f'\n[pty-driver: child exited status={status}]\n'.encode())
            break
        time.sleep(0.5)
    t1.join(timeout=2)

if __name__ == '__main__':
    main()
