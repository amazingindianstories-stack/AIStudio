import apps.common.indexes
import django.contrib.postgres.functions
from django.db import migrations, models

class Migration(migrations.Migration):
    initial = True
    dependencies = [('agents', '0001_railway_v2_agentconversation')]
    operations = [migrations.SeparateDatabaseAndState(database_operations=[migrations.RunSQL(sql=['CREATE TABLE "agent_conversation_messages" (\n"id" uuid DEFAULT gen_random_uuid() NOT NULL,\n"conversation_id" uuid NOT NULL,\n"role" text NOT NULL,\n"content" text NOT NULL,\n"tool_trace" jsonb,\n"created_at" bigint NOT NULL,\nCONSTRAINT "agent_conversation_messages_pkey" PRIMARY KEY (id)\n)', 'CREATE INDEX agent_conversation_messages_conversation_id_idx ON public.agent_conversation_messages USING btree (conversation_id)'])], state_operations=[migrations.CreateModel(name='AgentConversationMessage', fields=[('id', models.UUIDField(db_default=django.contrib.postgres.functions.RandomUUID(), primary_key=True, serialize=False)), ('conversation_id', models.UUIDField()), ('role', models.TextField()), ('content', models.TextField()), ('tool_trace', models.JSONField(null=True)), ('created_at', models.BigIntegerField())], options={'db_table': 'agent_conversation_messages', 'managed': True, 'indexes': [apps.common.indexes.PostgreSQLIndex(models.OrderBy(models.F('conversation_id'), nulls_last=True), name='agent_conversation_messages_conversation_id_idx')], 'constraints': []})])]
