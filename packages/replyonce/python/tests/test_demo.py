import asyncio
import subprocess
import sys

from replyonce.demo import format_report, run_demo


def test_same_seed_gives_the_same_counts():
    for seed in (1, 7, 42):
        first = asyncio.run(run_demo(conversations=150, seed=seed))
        second = asyncio.run(run_demo(conversations=150, seed=seed))
        assert first == second
        without, with_ = first
        assert without.duplicate_answers > 0
        assert with_.duplicate_answers == 0
        assert with_.unanswered == 0


def test_different_seeds_give_different_runs():
    a, _ = asyncio.run(run_demo(conversations=150, seed=1))
    b, _ = asyncio.run(run_demo(conversations=150, seed=2))
    assert a.faults != b.faults


def test_cli_prints_the_same_report_in_separate_processes():
    cmd = [sys.executable, "-m", "replyonce.cli", "demo", "--conversations", "80", "--seed", "11"]
    first = subprocess.run(cmd, capture_output=True, text=True, check=True)
    second = subprocess.run(cmd, capture_output=True, text=True, check=True)
    assert first.stdout == second.stdout
    assert "No customer message was answered twice" in first.stdout


def test_report_shape_is_unchanged():
    without, with_ = asyncio.run(run_demo(conversations=20, seed=3))
    assert format_report(without, with_).splitlines()[0] == "replyonce demo: 20 simulated support conversations under injected faults"
