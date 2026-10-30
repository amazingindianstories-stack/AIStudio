from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('assets', '0006_portrait_gallery'),
    ]

    operations = [
        migrations.AddField(
            model_name='managedportraitasset',
            name='media_kind',
            field=models.TextField(db_default='image', default='image'),
        ),
    ]
