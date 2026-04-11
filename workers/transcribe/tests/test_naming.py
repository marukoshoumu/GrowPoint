"""
ファイル命名テスト。GAS の getChunkTranscriptBasePrefix_ / formatChunkTranscriptIndexPad_ と
同一入力に対して同一出力になることを保証する。
"""

import pytest

from app.naming import transcript_filename, chunk_transcript_filename


class TestTranscriptFilename:
    """単一ファイル: {date}_{userName}_文字起こし.txt"""

    def test_basic(self):
        assert transcript_filename("2026-04-11", "田中") == "2026-04-11_田中_文字起こし.txt"

    def test_ascii_name(self):
        assert transcript_filename("2025-01-01", "tanaka") == "2025-01-01_tanaka_文字起こし.txt"

    def test_empty_date(self):
        """date は GAS 側で必ず yyyy-MM-dd に正規化されて渡る"""
        assert transcript_filename("", "田中") == "_田中_文字起こし.txt"


class TestChunkTranscriptFilename:
    """チャンク: {date}_{userName}_文字起こし_{NN}.txt"""

    def test_two_chunks_first(self):
        assert chunk_transcript_filename("2026-04-11", "田中", 1, 2) == "2026-04-11_田中_文字起こし_01.txt"

    def test_two_chunks_second(self):
        assert chunk_transcript_filename("2026-04-11", "田中", 2, 2) == "2026-04-11_田中_文字起こし_02.txt"

    def test_ten_chunks(self):
        assert chunk_transcript_filename("2026-04-11", "田中", 1, 10) == "2026-04-11_田中_文字起こし_01.txt"
        assert chunk_transcript_filename("2026-04-11", "田中", 10, 10) == "2026-04-11_田中_文字起こし_10.txt"

    def test_hundred_chunks(self):
        assert chunk_transcript_filename("2026-04-11", "田中", 1, 100) == "2026-04-11_田中_文字起こし_001.txt"
        assert chunk_transcript_filename("2026-04-11", "田中", 100, 100) == "2026-04-11_田中_文字起こし_100.txt"

    def test_invalid_chunk_index_raises(self):
        with pytest.raises(ValueError, match="chunk_index"):
            chunk_transcript_filename("2026-04-11", "田中", 0, 2)
        with pytest.raises(ValueError, match="chunk_index"):
            chunk_transcript_filename("2026-04-11", "田中", 3, 2)

    def test_invalid_chunk_total_raises(self):
        with pytest.raises(ValueError, match="chunk_total"):
            chunk_transcript_filename("2026-04-11", "田中", 1, 0)
