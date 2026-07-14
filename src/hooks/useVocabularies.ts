import { useState, useEffect, useCallback } from "react";
import { getVocabularies, addVocabulary, updateVocabulary, removeVocabulary } from "../lib/tauriApi";
import { toastError } from "../lib/toast";
import i18n from "../i18n";
import type { Vocabulary } from "../types";

export function useVocabularies() {
  const [vocabularies, setVocabularies] = useState<Vocabulary[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await getVocabularies();
      setVocabularies(data);
    } catch (e) {
      console.error("Failed to load vocabularies:", e);
      toastError(i18n.t("toast.vocabLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const add = useCallback(async (vocabulary: Vocabulary) => {
    try {
      const updated = await addVocabulary(vocabulary);
      setVocabularies(updated);
      return updated;
    } catch (e) {
      console.error("Failed to add vocabulary:", e);
      toastError(i18n.t("toast.vocabSaveFailed"));
      throw e;
    }
  }, []);

  const update = useCallback(async (vocabulary: Vocabulary) => {
    try {
      const updated = await updateVocabulary(vocabulary);
      setVocabularies(updated);
      return updated;
    } catch (e) {
      console.error("Failed to update vocabulary:", e);
      toastError(i18n.t("toast.vocabSaveFailed"));
      throw e;
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    try {
      const updated = await removeVocabulary(id);
      setVocabularies(updated);
      return updated;
    } catch (e) {
      console.error("Failed to remove vocabulary:", e);
      toastError(i18n.t("toast.vocabDeleteFailed"));
      throw e;
    }
  }, []);

  return { vocabularies, loading, reload: load, add, update, remove };
}
